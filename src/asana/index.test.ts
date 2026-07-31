import { afterEach, describe, expect, test } from "bun:test";

import { execute } from "../cli/index.ts";
import { AsanaHttpClient } from "./index.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.stop(true)));

const serverFor = (
  fetcher: (request: Request) => Response | Promise<Response>,
): string => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fetcher });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/api/1.0`;
};

describe("AsanaHttpClient", () => {
  test("gets the authenticated user with Asana authorization", async () => {
    const baseUrl = serverFor((request) => {
      expect(request.headers.get("authorization")).toBe("Bearer top-secret");
      expect(new URL(request.url).searchParams.get("opt_fields")).toBe(
        "gid,name",
      );
      return Response.json({ data: { gid: "1", name: "Ada" } });
    });
    const result = await new AsanaHttpClient({ baseUrl }).getAuthenticatedUser(
      "top-secret",
    );
    expect(result).toEqual({ ok: true, value: { gid: "1", name: "Ada" } });
  });

  test("retries GET rate limits and honors Retry-After", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const baseUrl = serverFor(() => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, { status: 429, headers: { "Retry-After": "2" } })
        : Response.json({ data: { gid: "1", name: "Ada" } });
    });
    const result = await new AsanaHttpClient({
      baseUrl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).getAuthenticatedUser("x");
    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(waits).toEqual([2000]);
  });

  test("honors an HTTP-date Retry-After before jitter", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const baseUrl = serverFor(() => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, {
            status: 429,
            headers: { "Retry-After": "Thu, 01 Jan 1970 00:00:12 GMT" },
          })
        : Response.json({ data: { gid: "1", name: "Ada" } });
    });
    const result = await new AsanaHttpClient({
      baseUrl,
      now: () => 10_000,
      random: () => 0.99,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    }).getAuthenticatedUser("x");
    expect(result.ok).toBe(true);
    expect(waits).toEqual([2000]);
  });

  test("uses exponential backoff with jitter for retryable GET failures", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const baseUrl = serverFor(() => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, { status: 503 })
        : Response.json({ data: { gid: "1", name: "Ada" } });
    });
    const result = await new AsanaHttpClient({
      baseUrl,
      random: () => 0.25,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    }).getAuthenticatedUser("x");
    expect(result.ok).toBe(true);
    expect(waits).toEqual([1250]);
  });

  test.each([502, 503, 504])("retries GET %i responses", async (status) => {
    let attempts = 0;
    const baseUrl = serverFor(() => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, { status })
        : Response.json({ data: { gid: "1", name: "Ada" } });
    });
    const result = await new AsanaHttpClient({
      baseUrl,
      sleep: async () => undefined,
    }).getAuthenticatedUser("x");
    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  test("returns rate-limit failure after the maximum retry count", async () => {
    let attempts = 0;
    const baseUrl = serverFor(() => {
      attempts += 1;
      return new Response(null, { status: 503 });
    });
    const result = await new AsanaHttpClient({
      baseUrl,
      maxRetries: 2,
      sleep: async () => undefined,
    }).getAuthenticatedUser("x");
    expect(attempts).toBe(3);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "rate_limit",
        status: 503,
        message: "Asana request retries exhausted",
      },
    });
  });

  test("aborts a request at the configured timeout", async () => {
    const baseUrl = serverFor(() => new Promise<Response>(() => undefined));
    const result = await new AsanaHttpClient({
      baseUrl,
      maxRetries: 0,
      requestTimeoutMs: 1,
    }).getAuthenticatedUser("x");
    expect(result).toEqual({
      ok: false,
      error: { kind: "network", message: "Unable to reach Asana" },
    });
  });

  test("returns a network failure when the server is unavailable", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ data: { gid: "1", name: "Ada" } }),
    });
    const baseUrl = `http://127.0.0.1:${server.port}/api/1.0`;
    server.stop(true);

    const result = await new AsanaHttpClient({
      baseUrl,
      maxRetries: 0,
    }).getAuthenticatedUser("x");
    expect(result).toEqual({
      ok: false,
      error: { kind: "network", message: "Unable to reach Asana" },
    });
  });

  test("execute maps real adapter retry exhaustion to exit code 5", async () => {
    let attempts = 0;
    const baseUrl = serverFor(() => {
      attempts += 1;
      return new Response(null, { status: 429 });
    });
    const result = await execute(["whoami"], {
      environment: { ASANA_CLI_TOKEN: "secret" },
      identity: new AsanaHttpClient({
        baseUrl,
        maxRetries: 1,
        sleep: async () => undefined,
      }),
    });
    expect(attempts).toBe(2);
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"code": "rate_limit"');
    expect(result.stderr).not.toContain("secret");
  });

  test("uses the default retry wait for a retryable GET response", async () => {
    let attempts = 0;
    const baseUrl = serverFor(() => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, { status: 503 })
        : Response.json({ data: { gid: "1", name: "Ada" } });
    });
    const result = await new AsanaHttpClient({ baseUrl }).getAuthenticatedUser(
      "x",
    );
    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  test("returns safe authentication and malformed-response failures", async () => {
    const authBaseUrl = serverFor(
      () => new Response("secret", { status: 401 }),
    );
    const auth = await new AsanaHttpClient({
      baseUrl: authBaseUrl,
    }).getAuthenticatedUser("secret");
    expect(auth).toEqual({
      ok: false,
      error: {
        kind: "authentication",
        status: 401,
        message: "Asana authentication failed",
      },
    });

    const malformedBaseUrl = serverFor(() => Response.json({ nope: true }));
    const malformed = await new AsanaHttpClient({
      baseUrl: malformedBaseUrl,
    }).getAuthenticatedUser("secret");
    expect(malformed).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Asana returned an invalid response",
      },
    });
  });
});

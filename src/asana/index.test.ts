import { afterEach, describe, expect, test } from "bun:test";

import { AsanaHttpClient } from "./index.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.stop()));

const serverFor = (fetcher: (request: Request) => Response): string => {
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

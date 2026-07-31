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
    const client = new AsanaHttpClient({
      baseUrl,
      maxRetries: 1,
      sleep: async () => undefined,
    });
    const result = await execute(["whoami"], {
      environment: { ASANA_CLI_TOKEN: "secret" },
      identity: client,
      discovery: client,
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

  test("discoverMyTasks succeeds with all required GET requests and opt_fields", async () => {
    let utlCalled = false;
    let sectionsCalled = false;
    let fieldsCalled = false;

    const baseUrl = serverFor((request) => {
      const url = new URL(request.url);
      expect(request.headers.get("authorization")).toBe("Bearer secret-token");

      if (url.pathname.endsWith("/users/me/user_task_list")) {
        expect(url.searchParams.get("workspace")).toBe("1201947864389005");
        expect(url.searchParams.get("opt_fields")).toBe("gid,workspace.gid");
        utlCalled = true;
        return Response.json({
          data: {
            gid: "1213894072990299",
            workspace: { gid: "1201947864389005" },
          },
        });
      }

      if (url.pathname.endsWith("/projects/1213894072990299/sections")) {
        expect(url.searchParams.get("limit")).toBe("100");
        expect(url.searchParams.get("opt_fields")).toBe("gid,name");
        sectionsCalled = true;
        return Response.json({
          data: [
            { gid: "1213894072991394", name: "In Progress" },
            { gid: "1213894072991395", name: "Done" },
          ],
        });
      }

      if (
        url.pathname.endsWith(
          "/projects/1213894072990299/custom_field_settings",
        )
      ) {
        expect(url.searchParams.get("limit")).toBe("100");
        expect(url.searchParams.get("opt_fields")).toBe(
          "custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.is_value_read_only",
        );
        fieldsCalled = true;
        return Response.json({
          data: [
            {
              custom_field: {
                gid: "1213894072991499",
                name: "Hours Estimate",
                resource_subtype: "number",
                is_value_read_only: false,
              },
            },
          ],
        });
      }

      return new Response("Not Found", { status: 404 });
    });

    const client = new AsanaHttpClient({ baseUrl });
    const result = await client.discoverMyTasks(
      "secret-token",
      "1201947864389005",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.userTaskListGid).toBe("1213894072990299");
      expect(result.value.sections).toEqual([
        { gid: "1213894072991394", name: "In Progress" },
        { gid: "1213894072991395", name: "Done" },
      ]);
      expect(result.value.customFields).toEqual([
        {
          gid: "1213894072991499",
          name: "Hours Estimate",
          resourceSubtype: "number",
          isReadOnly: false,
        },
      ]);
    }
    expect(utlCalled).toBe(true);
    expect(sectionsCalled).toBe(true);
    expect(fieldsCalled).toBe(true);
  });

  test("discoverMyTasks fails if next_page pagination is non-null for sections", async () => {
    const baseUrl = serverFor((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/users/me/user_task_list")) {
        return Response.json({
          data: {
            gid: "1213894072990299",
            workspace: { gid: "1201947864389005" },
          },
        });
      }
      if (url.pathname.endsWith("/projects/1213894072990299/sections")) {
        return Response.json({
          data: [{ gid: "1", name: "Sec" }],
          next_page: { offset: "foo" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const client = new AsanaHttpClient({ baseUrl });
    const result = await client.discoverMyTasks("token", "1201947864389005");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.message).toContain("sections; next_page is present");
    }
  });

  test("discoverMyTasks fails if next_page pagination is non-null for custom fields", async () => {
    const baseUrl = serverFor((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/users/me/user_task_list")) {
        return Response.json({
          data: {
            gid: "1213894072990299",
            workspace: { gid: "1201947864389005" },
          },
        });
      }
      if (url.pathname.endsWith("/projects/1213894072990299/sections")) {
        return Response.json({
          data: [{ gid: "1", name: "Sec" }],
        });
      }
      if (
        url.pathname.endsWith(
          "/projects/1213894072990299/custom_field_settings",
        )
      ) {
        return Response.json({
          data: [
            {
              custom_field: {
                gid: "1",
                name: "CF",
                resource_subtype: "number",
                is_value_read_only: false,
              },
            },
          ],
          next_page: { offset: "foo" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const client = new AsanaHttpClient({ baseUrl });
    const result = await client.discoverMyTasks("token", "1201947864389005");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.message).toContain(
        "custom field settings; next_page is present",
      );
    }
  });

  test("discoverMyTasks fails if returned user task list workspace GID does not match requested workspace GID", async () => {
    const baseUrl = serverFor((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/users/me/user_task_list")) {
        return Response.json({
          data: {
            gid: "1213894072990299",
            workspace: { gid: "1201947864389005" },
          },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const client = new AsanaHttpClient({ baseUrl });
    const result = await client.discoverMyTasks("token", "9999999");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.message).toContain(
        "Returned user task list workspace GID 1201947864389005 does not match requested workspace GID 9999999",
      );
    }
  });

  test("getTask fetches a task with exact required and optional fields", async () => {
    const taskPayload = {
      gid: "1215978111726134",
      name: "Implement the change",
      notes: "This is a task description",
      completed: true,
      due_on: "2026-12-31",
      assignee: {
        gid: "12345",
        name: "Ada Lovelace",
      },
      extra_field: "extra_value",
    };

    let called = false;
    const baseUrl = serverFor((request) => {
      called = true;
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/1.0/tasks/1215978111726134");
      expect(url.searchParams.get("opt_fields")).toBe(
        "gid,name,notes,completed,due_on,assignee.gid,assignee.name,extra_field",
      );
      return Response.json({ data: taskPayload });
    });

    const client = new AsanaHttpClient({ baseUrl });
    const result = await client.getTask("test-token", "1215978111726134", [
      "gid",
      "name",
      "notes",
      "completed",
      "due_on",
      "assignee.gid",
      "assignee.name",
      "extra_field",
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(taskPayload);
    }
    expect(called).toBe(true);
  });

  test("exact default opt_fields success with realistic resource_type/extra payload", async () => {
    const taskPayload = {
      gid: "1215978111726134",
      name: "Default Task",
      notes: "Some notes",
      completed: false,
      due_on: null,
      assignee: null,
      resource_type: "task",
      resource_subtype: "default_task",
    };

    let called = false;
    const baseUrl = serverFor((request) => {
      called = true;
      const url = new URL(request.url);
      expect(url.searchParams.get("opt_fields")).toBe(
        "gid,name,notes,completed,due_on,assignee.gid,assignee.name",
      );
      return Response.json({ data: taskPayload });
    });

    const client = new AsanaHttpClient({ baseUrl });
    const result = await client.getTask("test-token", "1215978111726134", [
      "gid",
      "name",
      "notes",
      "completed",
      "due_on",
      "assignee.gid",
      "assignee.name",
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(taskPayload);
    }
    expect(called).toBe(true);
  });

  test("exact custom selection such as gid,name,permalink_url returning only those fields", async () => {
    const taskPayload = {
      gid: "9876543210",
      name: "Custom Field Selection Task",
      permalink_url: "https://app.asana.com/0/123/9876543210",
    };

    let called = false;
    const baseUrl = serverFor((request) => {
      called = true;
      const url = new URL(request.url);
      expect(url.searchParams.get("opt_fields")).toBe("gid,name,permalink_url");
      return Response.json({ data: taskPayload });
    });

    const client = new AsanaHttpClient({ baseUrl });
    const result = await client.getTask("test-token", "9876543210", [
      "gid",
      "name",
      "permalink_url",
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(taskPayload);
    }
    expect(called).toBe(true);
  });

  test("preserves requested response field order in human output", async () => {
    const baseUrl = serverFor((request) => {
      expect(new URL(request.url).searchParams.get("opt_fields")).toBe(
        "notes,name,assignee.name,assignee.gid",
      );
      return Response.json({
        data: {
          notes: "Notes first",
          name: "Name second",
          assignee: {
            name: "Assignee name third",
            gid: "12345",
          },
        },
      });
    });
    const client = new AsanaHttpClient({ baseUrl });

    const result = await execute(
      [
        "tasks",
        "get",
        "9876543210",
        "--fields",
        "notes,name,assignee.name,assignee.gid",
      ],
      {
        environment: { ASANA_CLI_TOKEN: "test-token" },
        identity: client,
        taskReader: client,
      },
    );

    expect(result).toEqual({
      stdout:
        [
          "notes: Notes first",
          "name: Name second",
          "assignee.name: Assignee name third",
          "assignee.gid: 12345",
        ].join("\n") + "\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("requires requested fields and validates known present fields", async () => {
    const cases: ReadonlyArray<
      Readonly<{
        fields: readonly string[];
        data: Record<string, unknown>;
      }>
    > = [
      { fields: ["name"], data: {} },
      { fields: ["name"], data: { name: false } },
      { fields: ["name"], data: { name: "Task", gid: "not-digits" } },
      {
        fields: ["assignee.gid"],
        data: { assignee: { name: "Ada" } },
      },
      {
        fields: ["assignee.name"],
        data: { assignee: { gid: "123" } },
      },
      {
        fields: ["assignee.gid"],
        data: { assignee: { gid: "not-digits" } },
      },
      {
        fields: ["name"],
        data: { name: "Task", completed: "false" },
      },
    ];

    for (const testCase of cases) {
      const baseUrl = serverFor(() => Response.json({ data: testCase.data }));
      const result = await new AsanaHttpClient({ baseUrl }).getTask(
        "test-token",
        "123",
        testCase.fields,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("invalid_response");
    }
  });

  test("task 404 mapped to not_found and not retried", async () => {
    let callCount = 0;
    const baseUrl = serverFor(() => {
      callCount += 1;
      return new Response("Not Found", { status: 404 });
    });

    const client = new AsanaHttpClient({ baseUrl });
    const result = await client.getTask("test-token", "123", ["gid", "name"]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("not_found");
      expect(result.error.status).toBe(404);
    }
    expect(callCount).toBe(1);
  });

  test("429 retry exhaustion honoring Retry-After", async () => {
    let callCount = 0;
    const waits: number[] = [];
    const baseUrl = serverFor(() => {
      callCount += 1;
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "1" },
      });
    });

    const client = new AsanaHttpClient({
      baseUrl,
      maxRetries: 2,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const result = await client.getTask("test-token", "123", ["gid", "name"]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("rate_limit");
      expect(result.error.status).toBe(429);
    }
    expect(callCount).toBe(3);
    expect(waits).toEqual([1000, 1000]);
  });

  test("503 retry then success", async () => {
    let callCount = 0;
    const waits: number[] = [];
    const baseUrl = serverFor(() => {
      callCount += 1;
      return callCount === 1
        ? new Response("Service Unavailable", { status: 503 })
        : Response.json({ data: { gid: "123", name: "Recovered Task" } });
    });

    const client = new AsanaHttpClient({
      baseUrl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const result = await client.getTask("test-token", "123", ["gid", "name"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("Recovered Task");
    }
    expect(callCount).toBe(2);
    expect(waits.length).toBe(1);
  });

  test("malformed JSON/schema", async () => {
    let baseUrl = serverFor(() => {
      return new Response("This is not JSON", { status: 200 });
    });
    let client = new AsanaHttpClient({ baseUrl });
    let result = await client.getTask("test-token", "123", ["gid", "name"]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
    }

    baseUrl = serverFor(() => {
      return Response.json({
        data: {
          gid: "non-digits-123",
          name: "Invalid GID Task",
        },
      });
    });
    client = new AsanaHttpClient({ baseUrl });
    result = await client.getTask("test-token", "123", ["gid", "name"]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
    }
  });
});

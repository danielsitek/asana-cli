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
    expect(result.stderr).toContain('"code":"rate_limit"');
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
          "custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.is_value_read_only,custom_field.enum_options.gid,custom_field.enum_options.name,custom_field.enum_options.enabled",
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
            {
              custom_field: {
                gid: "1213894072991503",
                name: "Priority",
                resource_subtype: "enum",
                is_value_read_only: false,
                enum_options: [
                  { gid: "1213894072991601", name: "Low", enabled: true },
                  { gid: "1213894072991602", name: "High", enabled: false },
                ],
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
        {
          gid: "1213894072991503",
          name: "Priority",
          resourceSubtype: "enum",
          isReadOnly: false,
          enumOptions: [
            { gid: "1213894072991601", name: "Low", enabled: true },
            { gid: "1213894072991602", name: "High", enabled: false },
          ],
        },
      ]);
    }
    expect(utlCalled).toBe(true);
    expect(sectionsCalled).toBe(true);
    expect(fieldsCalled).toBe(true);
  });

  test("discovers My Tasks sections without requesting custom fields", async () => {
    const requestedPaths: string[] = [];
    const baseUrl = serverFor((request) => {
      const url = new URL(request.url);
      requestedPaths.push(url.pathname);
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
          data: [{ gid: "1213894072991394", name: "In Progress" }],
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const client = new AsanaHttpClient({ baseUrl });
    const result = await client.discoverMyTaskSections(
      "secret-token",
      "1201947864389005",
    );

    expect(result).toEqual({
      ok: true,
      value: {
        userTaskListGid: "1213894072990299",
        sections: [{ gid: "1213894072991394", name: "In Progress" }],
      },
    });
    expect(requestedPaths).toHaveLength(2);
    expect(requestedPaths.some((path) => path.includes("custom_field"))).toBe(
      false,
    );
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

  test("discoverMyTasks fails if an enum custom field is missing enum_options", async () => {
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
        return Response.json({ data: [] });
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
                name: "Priority",
                resource_subtype: "enum",
                is_value_read_only: false,
              },
            },
          ],
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const client = new AsanaHttpClient({ baseUrl });
    const result = await client.discoverMyTasks("token", "1201947864389005");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.message).toContain("enum_options");
    }
  });

  test("discoverMyTasks rejects a malformed enum option GID", async () => {
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
        return Response.json({ data: [] });
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
                name: "Priority",
                resource_subtype: "enum",
                is_value_read_only: false,
                enum_options: [
                  { gid: "not-a-gid", name: "In Review", enabled: true },
                ],
              },
            },
          ],
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    const client = new AsanaHttpClient({ baseUrl });
    const result = await client.discoverMyTasks("token", "1201947864389005");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_response");
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

  test("updates a task with the exact PUT request", async () => {
    const baseUrl = serverFor(async (request) => {
      expect(request.method).toBe("PUT");
      expect(request.headers.get("authorization")).toBe("Bearer secret-token");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(new URL(request.url).pathname).toBe("/api/1.0/tasks/123");
      expect(await request.json()).toEqual({
        data: {
          name: "Renamed",
          notes: "Replacement\n",
          assignee: null,
          due_on: "2028-02-29",
          completed: true,
        },
      });
      return Response.json({
        data: {
          gid: "123",
          name: "Renamed",
          notes: "Replacement\n",
          assignee: null,
          due_on: "2028-02-29",
          completed: true,
        },
      });
    });

    const result = await new AsanaHttpClient({ baseUrl }).updateTask(
      "secret-token",
      "123",
      {
        name: "Renamed",
        notes: "Replacement\n",
        assignee: null,
        due_on: "2028-02-29",
        completed: true,
      },
    );

    expect(result).toEqual({
      ok: true,
      value: {
        gid: "123",
        name: "Renamed",
        notes: "Replacement\n",
        assignee: null,
        due_on: "2028-02-29",
        completed: true,
      },
    });
  });

  test("sends no opt_fields when no fields are selected", async () => {
    const baseUrl = serverFor(async (request) => {
      expect(new URL(request.url).searchParams.has("opt_fields")).toBe(false);
      return Response.json({ data: { gid: "123", name: "Renamed" } });
    });

    const result = await new AsanaHttpClient({ baseUrl }).updateTask(
      "secret-token",
      "123",
      { name: "Renamed" },
    );

    expect(result.ok).toBe(true);
  });

  test("requests the selected fields plus gid on update", async () => {
    const baseUrl = serverFor(async (request) => {
      expect(new URL(request.url).searchParams.get("opt_fields")).toBe(
        "gid,due_on",
      );
      return Response.json({ data: { gid: "123", due_on: "2026-08-15" } });
    });

    const result = await new AsanaHttpClient({ baseUrl }).updateTask(
      "secret-token",
      "123",
      { due_on: "2026-08-15" },
      ["due_on"],
    );

    expect(result).toEqual({
      ok: true,
      value: { gid: "123", due_on: "2026-08-15" },
    });
  });

  test("drops unrequested fields from a narrowed update response", async () => {
    const baseUrl = serverFor(async () =>
      Response.json({
        data: {
          gid: "123",
          due_on: "2026-08-15",
          name: "Leaked",
          notes: "Leaked notes",
          completed: false,
          custom_fields: [{ gid: "500", number_value: 3 }],
          memberships: [{ project: { gid: "9" } }],
          permalink_url: "https://app.asana.com/0/9/123",
        },
      }),
    );

    const result = await new AsanaHttpClient({ baseUrl }).updateTask(
      "secret-token",
      "123",
      { due_on: "2026-08-15" },
      ["due_on"],
    );

    expect(result).toEqual({
      ok: true,
      value: { gid: "123", due_on: "2026-08-15" },
    });
  });

  test("keeps only the requested leaves of a nested selected object", async () => {
    const baseUrl = serverFor(async () =>
      Response.json({
        data: {
          gid: "123",
          name: "Kept",
          assignee: {
            gid: "1001",
            name: "Ada",
            email: "ada@example.com",
            photo: { image_60x60: "https://example.com/a.png" },
          },
          workspace: { gid: "5", name: "Acme" },
        },
      }),
    );

    const result = await new AsanaHttpClient({ baseUrl }).updateTask(
      "secret-token",
      "123",
      { name: "Kept" },
      ["name", "assignee.gid"],
    );

    expect(result).toEqual({
      ok: true,
      value: { gid: "123", name: "Kept", assignee: { gid: "1001" } },
    });
  });

  test("projects arbitrary nested paths outside the known task fields", async () => {
    const baseUrl = serverFor(async () =>
      Response.json({
        data: {
          gid: "123",
          workspace: { gid: "5", name: "Acme", is_organization: true },
        },
      }),
    );

    const result = await new AsanaHttpClient({ baseUrl }).updateTask(
      "secret-token",
      "123",
      { name: "Kept" },
      ["workspace.name"],
    );

    expect(result).toEqual({
      ok: true,
      value: { gid: "123", workspace: { name: "Acme" } },
    });
  });

  test("projects selected paths through arrays", async () => {
    const baseUrl = serverFor(async () =>
      Response.json({
        data: {
          gid: "123",
          memberships: [
            {
              project: { gid: "9", name: "Alpha" },
              section: { gid: "10", name: "Doing" },
            },
            {
              project: { gid: "11", name: "Beta" },
              section: null,
            },
          ],
        },
      }),
    );

    const result = await new AsanaHttpClient({ baseUrl }).updateTask(
      "secret-token",
      "123",
      { name: "Kept" },
      ["memberships.project.name", "memberships.section.name"],
    );

    expect(result).toEqual({
      ok: true,
      value: {
        gid: "123",
        memberships: [
          { project: { name: "Alpha" }, section: { name: "Doing" } },
          { project: { name: "Beta" }, section: null },
        ],
      },
    });
  });

  test("rejects an update response whose requested nested leaf is absent", async () => {
    const baseUrl = serverFor(async () =>
      Response.json({
        data: { gid: "123", assignee: { name: "Ada" } },
      }),
    );

    const result = await new AsanaHttpClient({ baseUrl }).updateTask(
      "secret-token",
      "123",
      { name: "Kept" },
      ["assignee.gid"],
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Asana returned an invalid response",
      },
    });
  });

  test("keeps a null nullable resource on a requested nested path", async () => {
    const baseUrl = serverFor(async () =>
      Response.json({
        data: { gid: "123", assignee: null, name: "Leaked" },
      }),
    );

    const result = await new AsanaHttpClient({ baseUrl }).updateTask(
      "secret-token",
      "123",
      { assignee: null },
      ["assignee.gid", "assignee.name"],
    );

    expect(result).toEqual({
      ok: true,
      value: { gid: "123", assignee: null },
    });
  });

  test("returns the full response when no fields are selected", async () => {
    const verbose = {
      gid: "123",
      name: "Renamed",
      custom_fields: [{ gid: "500" }],
      permalink_url: "https://app.asana.com/0/9/123",
    };
    const baseUrl = serverFor(async () => Response.json({ data: verbose }));

    const result = await new AsanaHttpClient({ baseUrl }).updateTask(
      "secret-token",
      "123",
      { name: "Renamed" },
    );

    expect(result).toEqual({ ok: true, value: verbose });
  });

  test("does not duplicate an explicitly selected gid on update", async () => {
    const baseUrl = serverFor(async (request) => {
      expect(new URL(request.url).searchParams.get("opt_fields")).toBe(
        "gid,name",
      );
      return Response.json({ data: { gid: "123", name: "Renamed" } });
    });

    const result = await new AsanaHttpClient({ baseUrl }).updateTask(
      "secret-token",
      "123",
      { name: "Renamed" },
      ["gid", "name"],
    );

    expect(result.ok).toBe(true);
  });

  test("rejects an update response missing a selected field", async () => {
    const baseUrl = serverFor(async () =>
      Response.json({ data: { gid: "123" } }),
    );

    const result = await new AsanaHttpClient({ baseUrl }).updateTask(
      "secret-token",
      "123",
      { due_on: "2026-08-15" },
      ["due_on"],
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Asana returned an invalid response",
      },
    });
  });

  test("requests the selected fields plus gid on setParent", async () => {
    const baseUrl = serverFor(async (request) => {
      expect(new URL(request.url).searchParams.get("opt_fields")).toBe(
        "gid,name",
      );
      return Response.json({ data: { gid: "222", name: "Child" } });
    });

    const result = await new AsanaHttpClient({ baseUrl }).setTaskParent(
      "secret-token",
      "222",
      "456",
      ["name"],
    );

    expect(result).toEqual({ ok: true, value: { gid: "222", name: "Child" } });
  });

  test("requests the selected fields plus gid on create", async () => {
    const baseUrl = serverFor(async (request) => {
      expect(new URL(request.url).searchParams.get("opt_fields")).toBe(
        "gid,due_on",
      );
      return Response.json({ data: { gid: "777", due_on: "2026-08-15" } });
    });

    const result = await new AsanaHttpClient({ baseUrl }).createTask(
      "secret-token",
      { kind: "subtask", parentId: "9" },
      { name: "Child" },
      ["due_on"],
    );

    expect(result).toEqual({
      ok: true,
      value: { gid: "777", due_on: "2026-08-15" },
    });
  });

  test("narrows a setParent response to gid and the selected fields", async () => {
    const baseUrl = serverFor(async () =>
      Response.json({
        data: {
          gid: "222",
          name: "Child",
          parent: { gid: "456", name: "Parent" },
          permalink_url: "https://app.asana.com/0/9/222",
        },
      }),
    );

    const result = await new AsanaHttpClient({ baseUrl }).setTaskParent(
      "secret-token",
      "222",
      "456",
      ["name"],
    );

    expect(result).toEqual({ ok: true, value: { gid: "222", name: "Child" } });
  });

  test("narrows a create response to gid and the selected fields", async () => {
    const baseUrl = serverFor(async () =>
      Response.json({
        data: {
          gid: "777",
          due_on: "2026-08-15",
          name: "Leaked",
          projects: [{ gid: "9" }],
          permalink_url: "https://app.asana.com/0/9/777",
        },
      }),
    );

    const result = await new AsanaHttpClient({ baseUrl }).createTask(
      "secret-token",
      { kind: "subtask", parentId: "9" },
      { name: "Child" },
      ["due_on"],
    );

    expect(result).toEqual({
      ok: true,
      value: { gid: "777", due_on: "2026-08-15" },
    });
  });

  test("rejects a create response whose requested nested leaf is absent", async () => {
    const baseUrl = serverFor(async () =>
      Response.json({ data: { gid: "777", assignee: { name: "Ada" } } }),
    );

    const result = await new AsanaHttpClient({ baseUrl }).createTask(
      "secret-token",
      { kind: "subtask", parentId: "9" },
      { name: "Child" },
      ["assignee.gid"],
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Asana returned an invalid response",
      },
    });
  });

  test("rejects a create response missing a selected field", async () => {
    const baseUrl = serverFor(async () =>
      Response.json({ data: { gid: "777" } }),
    );

    const result = await new AsanaHttpClient({ baseUrl }).createTask(
      "secret-token",
      { kind: "subtask", parentId: "9" },
      { name: "Child" },
      ["due_on"],
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Asana returned an invalid response",
      },
    });
  });

  test("combines My Tasks fields in one exact PUT request", async () => {
    let calls = 0;
    const baseUrl = serverFor(async (request) => {
      calls += 1;
      expect(request.method).toBe("PUT");
      expect(new URL(request.url).pathname).toBe("/api/1.0/tasks/123");
      expect(await request.json()).toEqual({
        data: {
          assignee: "9001",
          assignee_section: "300",
          custom_fields: { "400": null, "500": 2.5 },
        },
      });
      return Response.json({
        data: {
          gid: "123",
          assignee: { gid: "9001", name: "Ada" },
          assignee_section: { gid: "300", name: "In Review" },
          custom_fields: [
            { gid: "400", number_value: null },
            { gid: "500", number_value: 2.5 },
          ],
        },
      });
    });

    const result = await new AsanaHttpClient({ baseUrl }).updateTask(
      "secret-token",
      "123",
      {
        assignee: "9001",
        assignee_section: "300",
        custom_fields: { "400": null, "500": 2.5 },
      },
    );

    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
  });

  test.each([429, 502, 503, 504])(
    "retries PUT %i responses",
    async (status) => {
      let attempts = 0;
      const waits: number[] = [];
      const baseUrl = serverFor(() => {
        attempts += 1;
        return attempts === 1
          ? new Response(
              null,
              status === 429
                ? { status, headers: { "Retry-After": "3" } }
                : { status },
            )
          : Response.json({ data: { gid: "123", name: "Updated" } });
      });
      const result = await new AsanaHttpClient({
        baseUrl,
        random: () => 0,
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        },
      }).updateTask("token", "123", { name: "Updated" });

      expect(result.ok).toBe(true);
      expect(attempts).toBe(2);
      expect(waits).toEqual([status === 429 ? 3000 : 1000]);
    },
  );

  test("retries a timed-out PUT network request", async () => {
    let attempts = 0;
    const baseUrl = serverFor(() => {
      attempts += 1;
      return attempts === 1
        ? new Promise<Response>(() => undefined)
        : Response.json({ data: { gid: "123", completed: true } });
    });
    const result = await new AsanaHttpClient({
      baseUrl,
      maxRetries: 1,
      requestTimeoutMs: 1,
      sleep: async () => undefined,
    }).updateTask("token", "123", { completed: true });

    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  test("maps PUT API failures without retrying unsafe statuses", async () => {
    let attempts = 0;
    const baseUrl = serverFor(() => {
      attempts += 1;
      return new Response("unsafe response details", { status: 400 });
    });
    const result = await new AsanaHttpClient({ baseUrl }).updateTask(
      "secret",
      "123",
      { name: "Updated" },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "api",
        status: 400,
        message: "Asana API request failed (400)",
      },
    });
    expect(attempts).toBe(1);
  });

  test("returns retry exhaustion and malformed PUT response failures", async () => {
    const exhaustedUrl = serverFor(() => new Response(null, { status: 503 }));
    const exhausted = await new AsanaHttpClient({
      baseUrl: exhaustedUrl,
      maxRetries: 1,
      sleep: async () => undefined,
    }).updateTask("token", "123", { name: "Updated" });
    expect(exhausted).toEqual({
      ok: false,
      error: {
        kind: "rate_limit",
        status: 503,
        message: "Asana request retries exhausted",
      },
    });

    const malformedUrl = serverFor(() => Response.json({ data: "invalid" }));
    const malformed = await new AsanaHttpClient({
      baseUrl: malformedUrl,
    }).updateTask("token", "123", { name: "Updated" });
    expect(malformed).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Asana returned an invalid response",
      },
    });
  });

  test("reparents a task with the exact setParent POST request", async () => {
    let calls = 0;
    const baseUrl = serverFor(async (request) => {
      calls += 1;
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer secret-token");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(new URL(request.url).pathname).toBe(
        "/api/1.0/tasks/222/setParent",
      );
      expect(await request.json()).toEqual({ data: { parent: "456" } });
      return Response.json({
        data: { gid: "222", name: "Moved", completed: false },
      });
    });

    const result = await new AsanaHttpClient({ baseUrl }).setTaskParent(
      "secret-token",
      "222",
      "456",
    );

    expect(result).toEqual({
      ok: true,
      value: { gid: "222", name: "Moved", completed: false },
    });
    expect(calls).toBe(1);
  });

  test("promotes a task with a null parent", async () => {
    const baseUrl = serverFor(async (request) => {
      expect(new URL(request.url).pathname).toBe(
        "/api/1.0/tasks/222/setParent",
      );
      expect(await request.json()).toEqual({ data: { parent: null } });
      return Response.json({ data: { gid: "222", name: "Promoted" } });
    });

    const result = await new AsanaHttpClient({ baseUrl }).setTaskParent(
      "secret-token",
      "222",
      null,
    );

    expect(result).toEqual({
      ok: true,
      value: { gid: "222", name: "Promoted" },
    });
  });

  test("rejects non-digit setParent GIDs without any request", async () => {
    let calls = 0;
    const baseUrl = serverFor(() => {
      calls += 1;
      return Response.json({ data: { gid: "222" } });
    });
    const client = new AsanaHttpClient({ baseUrl });

    expect(await client.setTaskParent("token", "not-a-gid", "456")).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Task GID is not digit-only",
      },
    });
    expect(await client.setTaskParent("token", "222", "not-a-gid")).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Parent task GID is not digit-only",
      },
    });
    expect(calls).toBe(0);
  });

  test("maps a setParent 404 to not_found without retrying", async () => {
    let calls = 0;
    const baseUrl = serverFor(() => {
      calls += 1;
      return new Response("unsafe response details", { status: 404 });
    });

    const result = await new AsanaHttpClient({ baseUrl }).setTaskParent(
      "token",
      "222",
      "456",
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: "not_found", status: 404, message: "Task not found" },
    });
    expect(calls).toBe(1);
  });

  test.each([500, 502, 503, 504])(
    "does not retry ambiguous setParent %i failures",
    async (status) => {
      let calls = 0;
      const baseUrl = serverFor(() => {
        calls += 1;
        return new Response("unsafe response details", { status });
      });

      const result = await new AsanaHttpClient({
        baseUrl,
        sleep: async () => undefined,
      }).setTaskParent("token", "222", "456");

      expect(result).toEqual({
        ok: false,
        error: {
          kind: "api",
          status,
          message: `Asana API request failed (${status})`,
        },
      });
      expect(calls).toBe(1);
    },
  );

  test("retries a 429 setParent response honoring Retry-After", async () => {
    let calls = 0;
    const waits: number[] = [];
    const baseUrl = serverFor(() => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 429, headers: { "Retry-After": "2" } })
        : Response.json({ data: { gid: "222", name: "Moved" } });
    });

    const result = await new AsanaHttpClient({
      baseUrl,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    }).setTaskParent("token", "222", "456");

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(waits).toEqual([2000]);
  });

  test("returns a safe failure for a malformed setParent response", async () => {
    const baseUrl = serverFor(() => Response.json({ data: "invalid" }));

    expect(
      await new AsanaHttpClient({ baseUrl }).setTaskParent(
        "token",
        "222",
        "456",
      ),
    ).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Asana returned an invalid response",
      },
    });
  });

  test("creates a subtask with the exact POST request", async () => {
    const baseUrl = serverFor(async (request) => {
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer secret-token");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(new URL(request.url).pathname).toBe("/api/1.0/tasks/123/subtasks");
      expect(await request.json()).toEqual({
        data: {
          name: "Child",
          notes: "Prepared\n",
          due_on: "2028-02-29",
          completed: false,
        },
      });
      return Response.json(
        { data: { gid: "456", name: "Child" } },
        { status: 201 },
      );
    });

    const result = await new AsanaHttpClient({ baseUrl }).createTask(
      "secret-token",
      { kind: "subtask", parentId: "123" },
      {
        name: "Child",
        notes: "Prepared\n",
        due_on: "2028-02-29",
        completed: false,
      },
    );

    expect(result).toEqual({
      ok: true,
      value: { gid: "456", name: "Child" },
    });
  });

  test.each([
    [
      { kind: "workspace", workspaceGid: "700" } as const,
      { name: "My task", workspace: "700" },
    ],
    [
      { kind: "project", projectGid: "800" } as const,
      { name: "Project task", projects: ["800"] },
    ],
  ])(
    "creates a standalone task with its explicit target",
    async (target, data) => {
      const baseUrl = serverFor(async (request) => {
        expect(request.method).toBe("POST");
        expect(new URL(request.url).pathname).toBe("/api/1.0/tasks");
        expect(await request.json()).toEqual({ data });
        return Response.json({ data: { gid: "456" } }, { status: 201 });
      });

      const result = await new AsanaHttpClient({ baseUrl }).createTask(
        "token",
        target,
        { name: data.name },
      );

      expect(result.ok).toBe(true);
    },
  );

  test("retries only explicit POST rate limits and honors Retry-After", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const baseUrl = serverFor(() => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, {
            status: 429,
            headers: { "Retry-After": "3" },
          })
        : Response.json({ data: { gid: "456" } }, { status: 201 });
    });

    const result = await new AsanaHttpClient({
      baseUrl,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    }).createTask(
      "token",
      { kind: "subtask", parentId: "123" },
      {
        name: "Child",
      },
    );

    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(waits).toEqual([3000]);
  });

  test.each([500, 502, 503, 504])(
    "does not retry ambiguous POST %i responses",
    async (status) => {
      let attempts = 0;
      const baseUrl = serverFor(() => {
        attempts += 1;
        return new Response(null, { status });
      });

      const result = await new AsanaHttpClient({
        baseUrl,
        maxRetries: 3,
        sleep: async () => undefined,
      }).createTask(
        "token",
        { kind: "subtask", parentId: "123" },
        {
          name: "Child",
        },
      );

      expect(result).toEqual({
        ok: false,
        error: {
          kind: "api",
          status,
          message: `Asana API request failed (${status})`,
        },
      });
      expect(attempts).toBe(1);
    },
  );

  test("does not retry an ambiguous timed-out POST", async () => {
    let attempts = 0;
    const baseUrl = serverFor(() => {
      attempts += 1;
      return new Promise<Response>(() => undefined);
    });

    const result = await new AsanaHttpClient({
      baseUrl,
      maxRetries: 3,
      requestTimeoutMs: 1,
      sleep: async () => undefined,
    }).createTask(
      "token",
      { kind: "subtask", parentId: "123" },
      {
        name: "Child",
      },
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: "network", message: "Unable to reach Asana" },
    });
    expect(attempts).toBe(1);
  });

  test("does not retry an unavailable POST network request", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ data: { gid: "456" } }),
    });
    const baseUrl = `http://127.0.0.1:${server.port}/api/1.0`;
    server.stop(true);
    const waits: number[] = [];

    const result = await new AsanaHttpClient({
      baseUrl,
      maxRetries: 3,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    }).createTask(
      "token",
      { kind: "subtask", parentId: "123" },
      {
        name: "Child",
      },
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: "network", message: "Unable to reach Asana" },
    });
    expect(waits).toEqual([]);
  });
});

describe("AsanaHttpClient comments", () => {
  test("gets task stories with exact pagination query and schema", async () => {
    const baseUrl = serverFor((request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/1.0/tasks/123/stories");
      expect(url.searchParams.get("limit")).toBe("50");
      expect(url.searchParams.get("opt_fields")).toBe(
        "gid,created_at,text,created_by.gid,created_by.name,resource_subtype",
      );
      expect(url.searchParams.get("offset")).toBe("abc");
      return Response.json({
        data: [
          {
            gid: "1",
            created_at: "2024-01-01T00:00:00.000Z",
            text: "hi",
            created_by: { gid: "1001", name: "Ada" },
            resource_subtype: "comment_added",
          },
        ],
        next_page: { offset: "next-token" },
      });
    });
    const result = await new AsanaHttpClient({ baseUrl }).getTaskStories(
      "token",
      "123",
      {
        fields: [
          "gid",
          "created_at",
          "text",
          "created_by.gid",
          "created_by.name",
          "resource_subtype",
        ],
        limit: 50,
        offset: "abc",
      },
    );
    expect(result).toEqual({
      ok: true,
      value: {
        stories: [
          {
            gid: "1",
            created_at: "2024-01-01T00:00:00.000Z",
            text: "hi",
            created_by: { gid: "1001", name: "Ada" },
            resource_subtype: "comment_added",
          },
        ],
        nextOffset: "next-token",
      },
    });
  });

  test("omits nextOffset when there is no next page", async () => {
    const baseUrl = serverFor(() =>
      Response.json({ data: [], next_page: null }),
    );
    const result = await new AsanaHttpClient({ baseUrl }).getTaskStories(
      "token",
      "123",
      { fields: ["gid"], limit: 100 },
    );
    expect(result).toEqual({ ok: true, value: { stories: [] } });
  });

  test("validates page limits before making a request", async () => {
    let attempts = 0;
    const baseUrl = serverFor(() => {
      attempts += 1;
      return Response.json({ data: [] });
    });
    for (const limit of [0, 101, 1.5]) {
      const result = await new AsanaHttpClient({ baseUrl }).getTaskStories(
        "token",
        "123",
        { fields: ["gid"], limit },
      );
      expect(result.ok).toBe(false);
    }
    expect(attempts).toBe(0);
  });

  test("validates requested nested leaves and permits a null creator", async () => {
    let response: unknown = {
      data: [
        {
          gid: "1",
          created_by: { gid: "1001", email: "ada@example.com" },
          resource_subtype: "comment_added",
        },
      ],
    };
    const baseUrl = serverFor(() => Response.json(response));
    const client = new AsanaHttpClient({ baseUrl });
    const fields = ["gid", "created_by.email", "resource_subtype"];

    expect(
      (await client.getTaskStories("token", "123", { fields, limit: 1 })).ok,
    ).toBe(true);
    response = {
      data: [
        {
          gid: "1",
          created_by: { gid: "1001" },
          resource_subtype: "comment_added",
        },
      ],
    };
    const missingLeaf = await client.getTaskStories("token", "123", {
      fields,
      limit: 1,
    });
    expect(missingLeaf).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Asana returned an invalid response",
      },
    });
    response = {
      data: [{ gid: "1", created_by: null, resource_subtype: "comment_added" }],
    };
    expect(
      (await client.getTaskStories("token", "123", { fields, limit: 1 })).ok,
    ).toBe(true);
  });

  test("maps 404 to not_found for stories", async () => {
    const baseUrl = serverFor(() => new Response(null, { status: 404 }));
    const result = await new AsanaHttpClient({ baseUrl }).getTaskStories(
      "token",
      "123",
      { fields: ["gid"], limit: 100 },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "not_found", status: 404, message: "Task not found" },
    });
  });

  test("posts a comment with exact body and opt_fields, returning the schema-validated comment", async () => {
    const baseUrl = serverFor(async (request) => {
      expect(request.method).toBe("POST");
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/1.0/tasks/123/stories");
      expect(url.searchParams.get("opt_fields")).toBe("gid,text");
      expect(await request.json()).toEqual({ data: { text: "hello" } });
      return Response.json({ data: { gid: "9", text: "hello" } });
    });
    const result = await new AsanaHttpClient({ baseUrl }).createTaskComment(
      "token",
      "123",
      "hello",
      ["gid", "text"],
    );
    expect(result).toEqual({ ok: true, value: { gid: "9", text: "hello" } });
  });
});

describe("AsanaHttpClient task list", () => {
  test("gets section tasks with exact query and schema", async () => {
    const baseUrl = serverFor((request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/1.0/sections/500/tasks");
      expect(url.searchParams.get("limit")).toBe("50");
      expect(url.searchParams.get("opt_fields")).toBe(
        "gid,name,completed,assignee.gid",
      );
      expect(url.searchParams.get("completed_since")).toBe(
        "2026-01-01T00:00:00.000Z",
      );
      expect(url.searchParams.get("offset")).toBe("abc");
      return Response.json({
        data: [
          {
            gid: "1",
            name: "Task 1",
            completed: false,
            assignee: { gid: "9001" },
          },
        ],
        next_page: { offset: "next-token" },
      });
    });
    const result = await new AsanaHttpClient({ baseUrl }).getSectionTasks(
      "token",
      "500",
      {
        fields: ["gid", "name", "completed", "assignee.gid"],
        limit: 50,
        offset: "abc",
        completedSince: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(result).toEqual({
      ok: true,
      value: {
        tasks: [
          {
            gid: "1",
            name: "Task 1",
            completed: false,
            assignee: { gid: "9001" },
          },
        ],
        nextOffset: "next-token",
      },
    });
  });

  test("gets project tasks with exact query and schema", async () => {
    const baseUrl = serverFor((request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/1.0/projects/600/tasks");
      return Response.json({ data: [], next_page: null });
    });
    const result = await new AsanaHttpClient({ baseUrl }).getProjectTasks(
      "token",
      "600",
      {
        fields: ["gid"],
        limit: 100,
        completedSince: "1970-01-01T00:00:00.000Z",
      },
    );
    expect(result).toEqual({ ok: true, value: { tasks: [] } });
  });

  test("rejects a non digit-only section or project GID before requesting", async () => {
    let attempts = 0;
    const baseUrl = serverFor(() => {
      attempts += 1;
      return Response.json({ data: [] });
    });
    const client = new AsanaHttpClient({ baseUrl });
    const options = {
      fields: ["gid"],
      limit: 10,
      completedSince: "1970-01-01T00:00:00.000Z",
    };
    expect(
      (await client.getSectionTasks("token", "not-a-gid", options)).ok,
    ).toBe(false);
    expect(
      (await client.getProjectTasks("token", "not-a-gid", options)).ok,
    ).toBe(false);
    expect(attempts).toBe(0);
  });

  test("validates page limits before making a request", async () => {
    let attempts = 0;
    const baseUrl = serverFor(() => {
      attempts += 1;
      return Response.json({ data: [] });
    });
    const client = new AsanaHttpClient({ baseUrl });
    for (const limit of [0, 101, 1.5]) {
      const result = await client.getSectionTasks("token", "1", {
        fields: ["gid"],
        limit,
        completedSince: "1970-01-01T00:00:00.000Z",
      });
      expect(result.ok).toBe(false);
    }
    expect(attempts).toBe(0);
  });

  test("maps 404 to not_found for section and project task lists", async () => {
    const baseUrl = serverFor(() => new Response(null, { status: 404 }));
    const client = new AsanaHttpClient({ baseUrl });
    const options = {
      fields: ["gid"],
      limit: 100,
      completedSince: "1970-01-01T00:00:00.000Z",
    };
    expect(await client.getSectionTasks("token", "1", options)).toEqual({
      ok: false,
      error: { kind: "not_found", status: 404, message: "Resource not found" },
    });
    expect(await client.getProjectTasks("token", "1", options)).toEqual({
      ok: false,
      error: { kind: "not_found", status: 404, message: "Resource not found" },
    });
  });
});

describe("AsanaHttpClient workspaces", () => {
  test("lists workspaces with exact pagination query and schema", async () => {
    const baseUrl = serverFor((request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/1.0/workspaces");
      expect(url.searchParams.get("limit")).toBe("50");
      expect(url.searchParams.get("opt_fields")).toBe("gid,name");
      expect(url.searchParams.get("offset")).toBe("abc");
      return Response.json({
        data: [{ gid: "1", name: "Acme" }],
        next_page: { offset: "next-token" },
      });
    });
    const result = await new AsanaHttpClient({ baseUrl }).listWorkspaces(
      "token",
      { limit: 50, offset: "abc" },
    );
    expect(result).toEqual({
      ok: true,
      value: {
        workspaces: [{ gid: "1", name: "Acme" }],
        nextOffset: "next-token",
      },
    });
  });

  test("omits nextOffset when there is no next page", async () => {
    const baseUrl = serverFor(() =>
      Response.json({ data: [], next_page: null }),
    );
    const result = await new AsanaHttpClient({ baseUrl }).listWorkspaces(
      "token",
      { limit: 100 },
    );
    expect(result).toEqual({ ok: true, value: { workspaces: [] } });
  });

  test("rejects an empty next_page offset before another request can be made", async () => {
    let attempts = 0;
    const baseUrl = serverFor(() => {
      attempts += 1;
      return Response.json({
        data: [{ gid: "1", name: "Acme" }],
        next_page: { offset: "" },
      });
    });
    const result = await new AsanaHttpClient({ baseUrl }).listWorkspaces(
      "token",
      { limit: 100 },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Asana returned an invalid response",
      },
    });
    expect(attempts).toBe(1);
  });

  test("tolerates unrelated Asana fields but omits them from the projected workspace", async () => {
    const baseUrl = serverFor(() =>
      Response.json({
        data: [
          {
            gid: "1",
            name: "Acme",
            resource_type: "workspace",
            is_organization: true,
          },
        ],
      }),
    );
    const result = await new AsanaHttpClient({ baseUrl }).listWorkspaces(
      "token",
      { limit: 100 },
    );
    expect(result).toEqual({
      ok: true,
      value: { workspaces: [{ gid: "1", name: "Acme" }] },
    });
  });

  test("rejects a workspace with a non-digit gid or missing name", async () => {
    let response: unknown = {
      data: [{ gid: "not-a-gid", name: "Acme" }],
    };
    const baseUrl = serverFor(() => Response.json(response));
    const client = new AsanaHttpClient({ baseUrl });

    const invalidGid = await client.listWorkspaces("token", { limit: 100 });
    expect(invalidGid).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Asana returned an invalid response",
      },
    });

    response = { data: [{ gid: "1" }] };
    const missingName = await client.listWorkspaces("token", { limit: 100 });
    expect(missingName).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Asana returned an invalid response",
      },
    });
  });

  test("validates page limits before making a request", async () => {
    let attempts = 0;
    const baseUrl = serverFor(() => {
      attempts += 1;
      return Response.json({ data: [] });
    });
    for (const limit of [0, 101, 1.5]) {
      const result = await new AsanaHttpClient({ baseUrl }).listWorkspaces(
        "token",
        { limit },
      );
      expect(result.ok).toBe(false);
    }
    expect(attempts).toBe(0);
  });

  test("maps authentication failures without retrying", async () => {
    let attempts = 0;
    const baseUrl = serverFor(() => {
      attempts += 1;
      return new Response(null, { status: 401 });
    });
    const result = await new AsanaHttpClient({ baseUrl }).listWorkspaces(
      "token",
      { limit: 100 },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "authentication",
        status: 401,
        message: "Asana authentication failed",
      },
    });
    expect(attempts).toBe(1);
  });
});

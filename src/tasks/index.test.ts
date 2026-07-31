import { describe, expect, test } from "bun:test";

import { err, ok } from "../shared/result.ts";
import type { DiscoveredMyTasks, ResolvedConfig } from "../config/index.ts";
import {
  DEFAULT_FIELDS,
  executeTaskUpdate,
  parseTaskId,
  prepareTaskUpdate,
  validateFieldList,
  type PreparedTaskUpdate,
  type TaskMutation,
  type TaskMutationGateway,
  type TaskUpdateDependencies,
  type TaskUpdateOptions,
} from "./index.ts";

class RecordingWriter implements TaskMutationGateway {
  calls: Array<
    Readonly<{ token: string; taskId: string; mutation: TaskMutation }>
  > = [];

  async updateTask(token: string, taskId: string, mutation: TaskMutation) {
    this.calls.push({ token, taskId, mutation });
    return ok({ gid: taskId });
  }
}

const dependenciesFor = (
  writer: RecordingWriter,
  overrides: Partial<TaskUpdateDependencies> = {},
): TaskUpdateDependencies => ({
  writer,
  resolveAuthenticatedUserGid: async () => ok("9001"),
  readFile: async () => "file contents",
  readStdin: async () => "stdin contents",
  ...overrides,
});

const resolvedConfiguration = (
  overrides: Partial<ResolvedConfig["value"]> = {},
): ResolvedConfig => ({
  value: {
    workspace: { gid: "100" },
    myTasks: {
      userTaskListGid: "200",
      sections: { in_review: "300" },
      customFields: { estimate: "400" },
    },
    network: { concurrency: 4, maxRetries: 3, requestTimeoutMs: 30_000 },
    ...overrides,
  },
  sources: {},
  paths: { global: "/config.json" },
});

const discoveredMyTasks = (
  overrides: Partial<DiscoveredMyTasks> = {},
): DiscoveredMyTasks => ({
  userTaskListGid: "200",
  sections: [{ gid: "300", name: "In Review" }],
  customFields: [
    {
      gid: "400",
      name: "Estimate",
      resourceSubtype: "number",
      isReadOnly: false,
    },
  ],
  ...overrides,
});

const myTasksDependenciesFor = (
  writer: RecordingWriter,
  overrides: Partial<TaskUpdateDependencies> = {},
): TaskUpdateDependencies =>
  dependenciesFor(writer, {
    reader: {
      getTask: async () => ok({ assignee: { gid: "9001" } }),
    },
    discovery: {
      discoverMyTasks: async () => ok(discoveredMyTasks()),
    },
    resolveConfiguration: async () => ok(resolvedConfiguration()),
    ...overrides,
  });

const preparedFor = (
  taskId: string,
  options: TaskUpdateOptions,
): PreparedTaskUpdate => {
  const prepared = prepareTaskUpdate(taskId, options);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error(prepared.error.message);
  return prepared.value;
};

describe("DEFAULT_FIELDS", () => {
  test("selects the supported task detail fields", () => {
    expect(DEFAULT_FIELDS).toEqual([
      "gid",
      "name",
      "notes",
      "completed",
      "due_on",
      "assignee.gid",
      "assignee.name",
    ]);
  });
});

describe("parseTaskId", () => {
  test("accepts digit-only GIDs", () => {
    expect(parseTaskId("1234567890")).toEqual({
      ok: true,
      value: "1234567890",
    });
  });

  test("accepts unambiguous Asana task URLs", () => {
    expect(
      parseTaskId("https://app.asana.com/0/1201947864389005/1215978111726134"),
    ).toEqual({
      ok: true,
      value: "1215978111726134",
    });
    expect(
      parseTaskId(
        "https://app.asana.com/0/1201947864389005/1215978111726134/f",
      ),
    ).toEqual({
      ok: true,
      value: "1215978111726134",
    });
  });

  test("rejects invalid or ambiguous URLs and non-digit GIDs", () => {
    for (const input of [
      "https://app.asana.com/0/1201947864389005/1215978111726134/",
      "https://app.asana.com/0/1201947864389005/1215978111726134/f/",
      "abc",
      "123a456",
      "https://app.asana.com/0/1201947864389005/1215978111726134/other",
      "https://app.asana.com/0/1201947864389005/list",
    ]) {
      expect(parseTaskId(input)).toEqual({
        ok: false,
        error: "Invalid task identifier",
      });
    }
  });
});

describe("validateFieldList", () => {
  test("trims fields and removes duplicates in first-seen order", () => {
    expect(validateFieldList(" notes, name,notes,assignee.gid ")).toEqual({
      ok: true,
      value: ["notes", "name", "assignee.gid"],
    });
  });

  test("rejects empty lists and segments", () => {
    expect(validateFieldList("  ")).toEqual({
      ok: false,
      error: "Fields list cannot be empty",
    });
    expect(validateFieldList("name,,notes")).toEqual({
      ok: false,
      error: "Fields list cannot contain empty segments",
    });
  });
});

describe("task update workflow", () => {
  test.each([
    ["invalid identifier", "not-a-gid", { name: "x" }],
    ["no mutation", "123", {}],
    ["empty custom field list", "123", { customFields: [] }],
    ["conflicting notes", "123", { notes: "x", notesFile: "x.md" }],
    ["invalid assignee", "123", { assignee: "ada@example.com" }],
    ["invalid date shape", "123", { dueOn: "31-12-2026" }],
    ["impossible date", "123", { dueOn: "2026-02-29" }],
    ["invalid completed", "123", { completed: "yes" }],
    ["invalid My Tasks section", "123", { mySection: "section" }],
    ["empty My Tasks alias", "123", { mySection: "@" }],
    ["missing custom field delimiter", "123", { customFields: ["123"] }],
    ["empty custom field value", "123", { customFields: ["123:"] }],
    ["multiple delimiters", "123", { customFields: ["123:1:2"] }],
    ["empty field selector", "123", { customFields: [":1"] }],
    ["non-GID field", "123", { customFields: ["field:1"] }],
    ["exponent number", "123", { customFields: ["123:1e3"] }],
    ["comma number", "123", { customFields: ["123:1,5"] }],
    ["NaN", "123", { customFields: ["123:NaN"] }],
    ["Infinity", "123", { customFields: ["123:Infinity"] }],
    ["leading decimal", "123", { customFields: ["123:.5"] }],
    ["trailing decimal", "123", { customFields: ["123:5."] }],
    ["duplicate raw field", "123", { customFields: ["456:1", "456:2"] }],
    [
      "duplicate alias field",
      "123",
      { customFields: ["@estimate:1", "@estimate:null"] },
    ],
  ])("rejects %s during preparation", (_, taskId, options) => {
    const result = prepareTaskUpdate(taskId, options);

    expect(result.ok).toBe(false);
  });

  test("prepares raw and aliased My Tasks mutations", () => {
    expect(
      prepareTaskUpdate("123", {
        mySection: "@in_review",
        customFields: ["456:-2.5", "@hours_estimate:null", "789:0"],
      }),
    ).toEqual({
      ok: true,
      value: {
        taskId: "123",
        mutation: {},
        resolveAssigneeMe: false,
        mySection: { kind: "alias", value: "in_review" },
        customFields: [
          { field: { kind: "gid", value: "456" }, value: -2.5 },
          {
            field: { kind: "alias", value: "hours_estimate" },
            value: null,
          },
          { field: { kind: "gid", value: "789" }, value: 0 },
        ],
      },
    });
  });

  test("builds all supported mutations and resolves me before writing", async () => {
    const writer = new RecordingWriter();
    const result = await executeTaskUpdate(
      "secret",
      preparedFor("https://app.asana.com/0/111/222", {
        name: "Renamed",
        notes: "Replacement",
        assignee: "me",
        dueOn: "2028-02-29",
        completed: "false",
      }),
      dependenciesFor(writer),
    );

    expect(result.ok).toBe(true);
    expect(writer.calls).toEqual([
      {
        token: "secret",
        taskId: "222",
        mutation: {
          name: "Renamed",
          notes: "Replacement",
          assignee: "9001",
          due_on: "2028-02-29",
          completed: false,
        },
      },
    ]);
  });

  test("preserves file and stdin notes without modification", async () => {
    for (const [notesFile, expected] of [
      ["description.md", "file notes\n\n"],
      ["-", "stdin notes\n"],
    ] as const) {
      const writer = new RecordingWriter();
      await executeTaskUpdate(
        "secret",
        preparedFor("123", { notesFile }),
        dependenciesFor(writer, {
          readFile: async (path) => {
            expect(path).toBe("description.md");
            return "file notes\n\n";
          },
          readStdin: async () => "stdin notes\n",
        }),
      );
      expect(writer.calls[0]?.mutation.notes).toBe(expected);
    }
  });

  test("maps explicit nulls and booleans", async () => {
    const writer = new RecordingWriter();
    await executeTaskUpdate(
      "secret",
      preparedFor("123", {
        assignee: "null",
        dueOn: "null",
        completed: "true",
      }),
      dependenciesFor(writer),
    );
    expect(writer.calls[0]?.mutation).toEqual({
      assignee: null,
      due_on: null,
      completed: true,
    });
  });

  test("does not write when notes or identity resolution fails", async () => {
    const writer = new RecordingWriter();
    const unreadable = await executeTaskUpdate(
      "secret",
      preparedFor("123", { notesFile: "missing.md" }),
      dependenciesFor(writer, {
        readFile: async () => {
          throw new Error("sensitive path");
        },
      }),
    );
    const unresolved = await executeTaskUpdate(
      "secret",
      preparedFor("123", { assignee: "me" }),
      dependenciesFor(writer, {
        resolveAuthenticatedUserGid: async () =>
          err({ kind: "authentication", message: "unsafe detail" }),
      }),
    );

    expect(unreadable).toEqual({
      ok: false,
      error: { kind: "invalid_usage", message: "Unable to read notes file" },
    });
    expect(unresolved.ok).toBe(false);
    expect(writer.calls).toHaveLength(0);
  });

  test("resolves and validates My Tasks values before one combined write", async () => {
    const writer = new RecordingWriter();
    const result = await executeTaskUpdate(
      "secret",
      preparedFor("123", {
        name: "Updated",
        mySection: "@in_review",
        customFields: ["500:2.5", "@estimate:null"],
      }),
      myTasksDependenciesFor(writer, {
        discovery: {
          discoverMyTasks: async (token, workspaceGid) => {
            expect({ token, workspaceGid }).toEqual({
              token: "secret",
              workspaceGid: "100",
            });
            return ok(
              discoveredMyTasks({
                customFields: [
                  {
                    gid: "400",
                    name: "Estimate",
                    resourceSubtype: "number",
                    isReadOnly: false,
                  },
                  {
                    gid: "500",
                    name: "Cost",
                    resourceSubtype: "number",
                    isReadOnly: false,
                  },
                ],
              }),
            );
          },
        },
      }),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        task: { gid: "123" },
        applied: {
          name: "Updated",
          assignee_section: "300",
          custom_fields: { "400": null, "500": 2.5 },
        },
      },
    });
    expect(writer.calls).toHaveLength(1);
  });

  test("rejects aliases resolving to the same custom field", async () => {
    const writer = new RecordingWriter();
    const result = await executeTaskUpdate(
      "secret",
      preparedFor("123", {
        customFields: ["@estimate:1", "400:2"],
      }),
      myTasksDependenciesFor(writer),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_usage",
        message: "--custom-field cannot update the same field more than once",
      },
    });
    expect(writer.calls).toHaveLength(0);
  });

  test.each([
    [
      "missing section alias",
      { mySection: "@missing" },
      {},
      "is not configured",
    ],
    [
      "missing field alias",
      { customFields: ["@missing:1"] },
      {},
      "is not configured",
    ],
    [
      "stale task list",
      { mySection: "300" },
      { discovery: discoveredMyTasks({ userTaskListGid: "201" }) },
      "does not match",
    ],
    ["section outside My Tasks", { mySection: "301" }, {}, "is not present"],
    [
      "field outside My Tasks",
      { customFields: ["401:1"] },
      {},
      "is not present",
    ],
    [
      "wrong field type",
      { customFields: ["400:1"] },
      {
        discovery: discoveredMyTasks({
          customFields: [
            {
              gid: "400",
              name: "Estimate",
              resourceSubtype: "text",
              isReadOnly: false,
            },
          ],
        }),
      },
      "is not a number field",
    ],
    [
      "read-only field",
      { customFields: ["400:1"] },
      {
        discovery: discoveredMyTasks({
          customFields: [
            {
              gid: "400",
              name: "Estimate",
              resourceSubtype: "number",
              isReadOnly: true,
            },
          ],
        }),
      },
      "is read-only",
    ],
  ] as const)(
    "rejects %s before writing",
    async (_, options, setup, message) => {
      const writer = new RecordingWriter();
      const dependencies = myTasksDependenciesFor(writer, {
        ...("discovery" in setup
          ? {
              discovery: {
                discoverMyTasks: async () => ok(setup.discovery),
              },
            }
          : {}),
      });
      const result = await executeTaskUpdate(
        "secret",
        preparedFor("123", options),
        dependencies,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain(message);
      expect(writer.calls).toHaveLength(0);
    },
  );

  test("requires the final assignee to be the authenticated user", async () => {
    for (const options of [
      { mySection: "300", assignee: "9002" },
      { customFields: ["400:1"], assignee: "null" },
      { mySection: "300" },
    ] as const) {
      const writer = new RecordingWriter();
      const result = await executeTaskUpdate(
        "secret",
        preparedFor("123", options),
        myTasksDependenciesFor(writer, {
          reader: {
            getTask: async () => ok({ assignee: { gid: "9002" } }),
          },
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("final assignee");
      expect(writer.calls).toHaveLength(0);
    }
  });

  test("does not read current task when explicit assignee is authenticated user", async () => {
    const writer = new RecordingWriter();
    let reads = 0;
    const result = await executeTaskUpdate(
      "secret",
      preparedFor("123", { mySection: "300", assignee: "me" }),
      myTasksDependenciesFor(writer, {
        reader: {
          getTask: async () => {
            reads += 1;
            return ok({});
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(reads).toBe(0);
    expect(writer.calls[0]?.mutation).toEqual({
      assignee: "9001",
      assignee_section: "300",
    });
  });

  test("propagates discovery and current-task read failures without writing", async () => {
    const writer = new RecordingWriter();
    const discoveryFailure = await executeTaskUpdate(
      "secret",
      preparedFor("123", { mySection: "300" }),
      myTasksDependenciesFor(writer, {
        discovery: {
          discoverMyTasks: async () =>
            err({ kind: "network", message: "offline" }),
        },
      }),
    );
    const readFailure = await executeTaskUpdate(
      "secret",
      preparedFor("123", { mySection: "300" }),
      myTasksDependenciesFor(writer, {
        reader: {
          getTask: async () => err({ kind: "not_found", message: "missing" }),
        },
      }),
    );

    expect(discoveryFailure.ok).toBe(false);
    expect(readFailure.ok).toBe(false);
    expect(writer.calls).toHaveLength(0);
  });
});

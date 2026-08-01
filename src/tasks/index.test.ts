import { describe, expect, test } from "bun:test";

import { err, ok, type Result } from "../shared/result.ts";
import {
  DEFAULT_FIELDS,
  executeTaskCreation,
  executeTaskUpdate,
  parseTaskId,
  prepareTaskUpdate,
  prepareTaskCreate,
  prepareTaskCreateWithDefault,
  validateFieldList,
  type PreparedTaskUpdate,
  type PreparedTaskCreate,
  type Task,
  type TaskCreationDependencies,
  type TaskCreationGateway,
  type TaskMutation,
  type TaskMutationGateway,
  type TaskReadError,
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

class RecordingCreator implements TaskCreationGateway {
  calls: Array<
    Readonly<{ token: string; parentId: string; mutation: TaskMutation }>
  > = [];

  constructor(
    private readonly response = ok<Task & Readonly<{ gid: string }>>({
      gid: "456",
      name: "Child",
    }),
  ) {}

  async createSubtask(token: string, parentId: string, mutation: TaskMutation) {
    this.calls.push({ token, parentId, mutation });
    return this.response;
  }
}

class QueuedWriter implements TaskMutationGateway {
  calls: Array<
    Readonly<{ token: string; taskId: string; mutation: TaskMutation }>
  > = [];

  constructor(
    private readonly responses: readonly Result<Task, TaskReadError>[],
  ) {}

  async updateTask(token: string, taskId: string, mutation: TaskMutation) {
    this.calls.push({ token, taskId, mutation });
    return (
      this.responses[this.calls.length - 1] ??
      err<TaskReadError>({
        kind: "invalid_response",
        message: "Missing fake response",
      })
    );
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

const preparedFor = (
  taskId: string,
  options: TaskUpdateOptions,
): PreparedTaskUpdate => {
  const prepared = prepareTaskUpdate(taskId, options);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error(prepared.error.message);
  return prepared.value;
};

const preparedCreateFor = (
  options: Parameters<typeof prepareTaskCreate>[0],
): PreparedTaskCreate => {
  const prepared = prepareTaskCreate(options);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error(prepared.error.message);
  return prepared.value;
};

const creationDependenciesFor = (
  creator: RecordingCreator,
  writer?: TaskMutationGateway,
  overrides: Partial<TaskCreationDependencies> = {},
): TaskCreationDependencies => ({
  creator,
  ...(writer ? { writer } : {}),
  resolveAuthenticatedUserGid: async () => ok("9001"),
  readFile: async () => "file contents",
  readStdin: async () => "stdin contents",
  ...overrides,
});

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

  test("delegates My Tasks resolution before one combined write", async () => {
    const writer = new RecordingWriter();
    let received: unknown;
    const result = await executeTaskUpdate(
      "secret",
      preparedFor("123", {
        name: "Updated",
        mySection: "@in_review",
        customFields: ["500:2.5", "@estimate:null"],
      }),
      dependenciesFor(writer, {
        myTasksMutationResolver: {
          resolve: async (request) => {
            received = request;
            return ok({
              assignee_section: "300",
              custom_fields: { "400": null, "500": 2.5 },
            });
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
    expect(received).toEqual({
      token: "secret",
      taskId: "123",
      mySection: { kind: "alias", value: "in_review" },
      customFields: [
        { field: { kind: "gid", value: "500" }, value: 2.5 },
        { field: { kind: "alias", value: "estimate" }, value: null },
      ],
    });
    expect(writer.calls).toHaveLength(1);
  });

  test("does not write when My Tasks resolution is unavailable or fails", async () => {
    const writer = new RecordingWriter();
    const unavailable = await executeTaskUpdate(
      "secret",
      preparedFor("123", { mySection: "300" }),
      dependenciesFor(writer),
    );
    const failed = await executeTaskUpdate(
      "secret",
      preparedFor("123", { mySection: "300" }),
      dependenciesFor(writer, {
        myTasksMutationResolver: {
          resolve: async () =>
            err({ kind: "configuration", message: "stale config" }),
        },
      }),
    );

    expect(unavailable).toEqual({
      ok: false,
      error: {
        kind: "internal_error",
        message: "My Tasks update dependencies are unavailable",
      },
    });
    expect(failed).toEqual({
      ok: false,
      error: { kind: "configuration", message: "stale config" },
    });
    expect(writer.calls).toHaveLength(0);
  });

  test("passes known authenticated assignee to My Tasks resolver", async () => {
    const writer = new RecordingWriter();
    let received: unknown;
    const result = await executeTaskUpdate(
      "secret",
      preparedFor("123", { mySection: "300", assignee: "me" }),
      dependenciesFor(writer, {
        myTasksMutationResolver: {
          resolve: async (request) => {
            received = request;
            return ok({ assignee_section: "300" });
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(received).toEqual({
      token: "secret",
      taskId: "123",
      finalAssignee: "9001",
      authenticatedUserGid: "9001",
      mySection: { kind: "gid", value: "300" },
      customFields: [],
    });
    expect(writer.calls[0]?.mutation).toEqual({
      assignee: "9001",
      assignee_section: "300",
    });
  });
});

describe("task creation preparation", () => {
  test("requires a parent and name", () => {
    expect(prepareTaskCreate({ name: "Child" })).toEqual({
      ok: false,
      error: { kind: "invalid_usage", message: "--parent is required" },
    });
    expect(prepareTaskCreate({ parent: "123" })).toEqual({
      ok: false,
      error: { kind: "invalid_usage", message: "--name is required" },
    });
  });

  test("shares mutation parsing and preserves the parsed parent", () => {
    expect(
      prepareTaskCreate({
        parent: "https://app.asana.com/0/111/222",
        name: "Child",
        notesFile: "notes.md",
        assignee: "me",
        dueOn: "2028-02-29",
        completed: "false",
        mySection: "@in_progress",
        customFields: ["@estimate:4"],
      }),
    ).toEqual({
      ok: true,
      value: {
        parentId: "222",
        mutation: {
          name: "Child",
          due_on: "2028-02-29",
          completed: false,
        },
        notesFile: "notes.md",
        resolveAssigneeMe: true,
        mySection: { kind: "alias", value: "in_progress" },
        customFields: [
          { field: { kind: "alias", value: "estimate" }, value: 4 },
        ],
      },
    });
  });

  test("requires an explicit assignable user for My Tasks values", () => {
    for (const assignee of [undefined, "null"] as const) {
      expect(
        prepareTaskCreate({
          parent: "123",
          name: "Child",
          ...(assignee === undefined ? {} : { assignee }),
          mySection: "300",
        }).ok,
      ).toBe(false);
    }
  });
});

describe("prepareTaskCreateWithDefault", () => {
  const optionsWithMySection = {
    parent: "123",
    name: "Child",
    mySection: "300",
  } as const;

  test("applies validated me and GID defaults", async () => {
    const ownTask = await prepareTaskCreateWithDefault(
      optionsWithMySection,
      async () => ok("me"),
    );
    expect(ownTask.ok && ownTask.value.resolveAssigneeMe).toBe(true);

    const delegatedTask = await prepareTaskCreateWithDefault(
      optionsWithMySection,
      async () => ok("9001"),
    );
    expect(delegatedTask.ok && delegatedTask.value.mutation.assignee).toBe(
      "9001",
    );
  });

  test("never resolves a default for an explicit assignee", async () => {
    for (const assignee of ["me", "9001", "null"] as const) {
      let resolverCalls = 0;
      const prepared = await prepareTaskCreateWithDefault(
        { parent: "123", name: "Child", assignee },
        async () => {
          resolverCalls += 1;
          return ok("8002");
        },
      );
      expect(prepared.ok).toBe(true);
      expect(resolverCalls).toBe(0);
    }
  });

  test("keeps an explicit null from satisfying the My Tasks precondition", async () => {
    let resolverCalls = 0;
    const prepared = await prepareTaskCreateWithDefault(
      { ...optionsWithMySection, assignee: "null" },
      async () => {
        resolverCalls += 1;
        return ok("me");
      },
    );
    expect(prepared.ok).toBe(false);
    expect(resolverCalls).toBe(0);
  });

  test("rejects an invalid resolved default", async () => {
    const prepared = await prepareTaskCreateWithDefault(
      { parent: "123", name: "Child" },
      async () => ok("not-a-gid"),
    );
    expect(prepared).toEqual({
      ok: false,
      error: {
        kind: "configuration",
        message: "defaultAssignee must be me or a digit-only user GID",
      },
    });
  });

  test("propagates default resolution failures", async () => {
    const prepared = await prepareTaskCreateWithDefault(
      { parent: "123", name: "Child" },
      async () => err({ kind: "configuration", message: "invalid config" }),
    );
    expect(prepared).toEqual({
      ok: false,
      error: { kind: "configuration", message: "invalid config" },
    });
  });
});

describe("task creation workflow", () => {
  test("creates a basic subtask without a mutation writer", async () => {
    const creator = new RecordingCreator();
    const result = await executeTaskCreation(
      "secret",
      preparedCreateFor({ parent: "123", name: "Child" }),
      creationDependenciesFor(creator),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        task: { gid: "456", name: "Child" },
        complete: true,
        stages: [
          {
            stage: "create",
            status: "completed",
            applied: { name: "Child" },
          },
          { stage: "assignee", status: "not_run", reason: "not_requested" },
          {
            stage: "my_section",
            status: "not_run",
            reason: "not_requested",
          },
          {
            stage: "custom_fields",
            status: "not_run",
            reason: "not_requested",
          },
        ],
      },
    });
    expect(creator.calls).toHaveLength(1);
  });

  test("requires a writer for requested stages before the POST", async () => {
    for (const options of [
      { parent: "123", name: "Child", assignee: "9001" },
      {
        parent: "123",
        name: "Child",
        assignee: "9001",
        mySection: "300",
      },
      {
        parent: "123",
        name: "Child",
        assignee: "9001",
        customFields: ["400:4"],
      },
    ]) {
      const creator = new RecordingCreator();
      const result = await executeTaskCreation(
        "secret",
        preparedCreateFor(options),
        creationDependenciesFor(creator, undefined, {
          myTasksMutationResolver: {
            resolve: async (request) =>
              ok({
                ...(request.mySection ? { assignee_section: "300" } : {}),
                ...(request.customFields.length > 0
                  ? { custom_fields: { "400": 4 } }
                  : {}),
              }),
          },
        }),
      );

      expect(result).toEqual({
        ok: false,
        error: {
          kind: "internal_error",
          message: "Task writer is required for staged subtask mutations",
        },
      });
      expect(creator.calls).toHaveLength(0);
    }
  });

  test("materializes all values before creating and preserves stage order", async () => {
    const creator = new RecordingCreator();
    const writer = new QueuedWriter([
      ok({ gid: "456", assignee: { gid: "9001" } }),
      ok({ gid: "456", assignee: { gid: "9001" } }),
      ok({ gid: "456", assignee: { gid: "9001" } }),
    ]);
    let resolverRequest: unknown;
    const result = await executeTaskCreation(
      "secret",
      preparedCreateFor({
        parent: "123",
        name: "Child",
        notesFile: "notes.md",
        assignee: "me",
        dueOn: "2028-02-29",
        completed: "false",
        mySection: "@in_progress",
        customFields: ["@estimate:4"],
      }),
      creationDependenciesFor(creator, writer, {
        readFile: async (path) => {
          expect(path).toBe("notes.md");
          return "Prepared notes\n";
        },
        myTasksMutationResolver: {
          resolve: async (request) => {
            resolverRequest = request;
            return ok({
              assignee_section: "300",
              custom_fields: { "400": 4 },
            });
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(resolverRequest).toEqual({
      token: "secret",
      finalAssignee: "9001",
      authenticatedUserGid: "9001",
      mySection: { kind: "alias", value: "in_progress" },
      customFields: [{ field: { kind: "alias", value: "estimate" }, value: 4 }],
    });
    expect(creator.calls[0]?.mutation).toEqual({
      name: "Child",
      notes: "Prepared notes\n",
      due_on: "2028-02-29",
      completed: false,
    });
    expect(writer.calls.map((call) => call.mutation)).toEqual([
      { assignee: "9001" },
      { assignee_section: "300" },
      { custom_fields: { "400": 4 } },
    ]);
  });

  test("does not POST when shared materialization fails", async () => {
    const cases: Array<
      readonly [PreparedTaskCreate, Partial<TaskCreationDependencies>]
    > = [
      [
        preparedCreateFor({
          parent: "123",
          name: "Child",
          notesFile: "missing.md",
        }),
        {
          readFile: async () => {
            throw new Error("unsafe path");
          },
        },
      ],
      [
        preparedCreateFor({
          parent: "123",
          name: "Child",
          assignee: "me",
        }),
        {
          resolveAuthenticatedUserGid: async () =>
            err({ kind: "authentication", message: "unsafe identity" }),
        },
      ],
      [
        preparedCreateFor({
          parent: "123",
          name: "Child",
          assignee: "me",
          mySection: "300",
        }),
        {
          myTasksMutationResolver: {
            resolve: async () =>
              err({ kind: "configuration", message: "stale config" }),
          },
        },
      ],
    ];

    for (const [prepared, overrides] of cases) {
      const creator = new RecordingCreator();
      const result = await executeTaskCreation(
        "secret",
        prepared,
        creationDependenciesFor(creator, new RecordingWriter(), overrides),
      );
      expect(result.ok).toBe(false);
      expect(creator.calls).toHaveLength(0);
    }
  });

  test.each([
    [0, ["failed", "not_run", "not_run"], 1],
    [1, ["completed", "failed", "not_run"], 2],
    [2, ["completed", "completed", "failed"], 3],
  ] as const)(
    "stops after failed stage %i and redacts the error",
    async (failureIndex, statuses, expectedWrites) => {
      const writer = new QueuedWriter(
        [0, 1, 2].map((index) =>
          index === failureIndex
            ? err<TaskReadError>({ kind: "api", message: "unsafe detail" })
            : ok<Task>({ gid: "456", name: "Child" }),
        ),
      );
      const creator = new RecordingCreator();
      const result = await executeTaskCreation(
        "secret",
        preparedCreateFor({
          parent: "123",
          name: "Child",
          assignee: "me",
          mySection: "300",
          customFields: ["400:4"],
        }),
        creationDependenciesFor(creator, writer, {
          myTasksMutationResolver: {
            resolve: async () =>
              ok({
                assignee_section: "300",
                custom_fields: { "400": 4 },
              }),
          },
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.complete).toBe(false);
      expect(writer.calls).toHaveLength(expectedWrites);
      expect(result.value.stages.slice(1).map((stage) => stage.status)).toEqual(
        [...statuses],
      );
      expect(result.value.stages[failureIndex + 1]?.error).toEqual({
        kind: "api",
        message: "Asana API request failed",
      });
      expect(JSON.stringify(result)).not.toContain("unsafe detail");
    },
  );
});

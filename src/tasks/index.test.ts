import { describe, expect, test } from "bun:test";

import { err, ok, type Result } from "../shared/result.ts";
import {
  DEFAULT_FIELDS,
  executeTaskCreation,
  executeTaskUpdate,
  executeTaskParentUpdate,
  parseTaskId,
  prepareTaskUpdate,
  prepareTaskParentUpdate,
  prepareTaskCreate,
  prepareTaskCreateWithConfig,
  validateFieldList,
  type PreparedTaskUpdate,
  type PreparedTaskCreate,
  type Task,
  type TaskCreationDependencies,
  type TaskCreationGateway,
  type TaskCreationTarget,
  type TaskMutation,
  type TaskMutationGateway,
  type TaskParentMutationGateway,
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
    Readonly<{
      token: string;
      target: TaskCreationTarget;
      mutation: TaskMutation;
    }>
  > = [];

  constructor(
    private readonly response = ok<Task & Readonly<{ gid: string }>>({
      gid: "456",
      name: "Child",
    }),
  ) {}

  async createTask(
    token: string,
    target: TaskCreationTarget,
    mutation: TaskMutation,
  ) {
    this.calls.push({ token, target, mutation });
    return this.response;
  }
}

class RecordingParentWriter implements TaskParentMutationGateway {
  calls: Array<
    Readonly<{ token: string; taskId: string; parentId: string | null }>
  > = [];

  constructor(
    private readonly response: Result<Task, TaskReadError> = ok({
      gid: "222",
      name: "Moved",
    }),
  ) {}

  async setTaskParent(token: string, taskId: string, parentId: string | null) {
    this.calls.push({ token, taskId, parentId });
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
    ["empty field selector", "123", { customFields: [":1"] }],
    ["non-GID field", "123", { customFields: ["field:1"] }],
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
          { field: { kind: "gid", value: "456" }, value: "-2.5" },
          {
            field: { kind: "alias", value: "hours_estimate" },
            value: null,
          },
          { field: { kind: "gid", value: "789" }, value: "0" },
        ],
      },
    });
  });

  test("preserves colons inside a custom field value", () => {
    const result = prepareTaskUpdate("123", {
      customFields: ["456:Review: Ready"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.customFields).toEqual([
        {
          field: { kind: "gid", value: "456" },
          value: "Review: Ready",
        },
      ]);
    }
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
        { field: { kind: "gid", value: "500" }, value: "2.5" },
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

describe("task parent update workflow", () => {
  test.each([
    ["invalid task identifier", "not-a-gid", { parent: "456" }],
    ["malformed parent", "123", { parent: "not-a-gid" }],
    ["empty parent", "123", { parent: "" }],
    [
      "unsupported parent URL",
      "123",
      { parent: "https://app.asana.com/0/222" },
    ],
    ["self parent by GID", "123", { parent: "123" }],
    [
      "self parent by URL",
      "123",
      { parent: "https://app.asana.com/0/111/123" },
    ],
    ["combined name", "123", { parent: "456", name: "Renamed" }],
    ["combined notes", "123", { parent: "456", notes: "text" }],
    ["combined notes file", "123", { parent: "456", notesFile: "notes.md" }],
    ["combined assignee", "123", { parent: "456", assignee: "me" }],
    ["combined due date", "123", { parent: "456", dueOn: "2028-02-29" }],
    ["combined completed", "123", { parent: "456", completed: "true" }],
    ["combined My Tasks section", "123", { parent: "456", mySection: "300" }],
    [
      "combined custom field",
      "123",
      { parent: "456", customFields: ["500:2.5"] },
    ],
  ])("rejects %s during preparation", (_, taskId, options) => {
    const result = prepareTaskParentUpdate(taskId, options);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_usage");
  });

  test("ignores an empty custom field list alongside --parent", () => {
    expect(
      prepareTaskParentUpdate("123", { parent: "456", customFields: [] }),
    ).toEqual({ ok: true, value: { taskId: "123", parentId: "456" } });
  });

  test.each([
    ["a GID", "456", "456"],
    ["a task URL", "https://app.asana.com/0/111/456", "456"],
    ["a focus task URL", "https://app.asana.com/0/111/456/f", "456"],
    ["literal null", "null", null],
  ])("prepares %s as the new parent", (_, parent, expected) => {
    expect(prepareTaskParentUpdate("222", { parent })).toEqual({
      ok: true,
      value: { taskId: "222", parentId: expected },
    });
  });

  test("reparents with exactly one write", async () => {
    const writer = new RecordingParentWriter();
    const prepared = prepareTaskParentUpdate(
      "https://app.asana.com/0/111/222",
      { parent: "456" },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);

    const result = await executeTaskParentUpdate("secret", prepared.value, {
      writer,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        task: { gid: "222", name: "Moved" },
        applied: { parent: "456" },
      },
    });
    expect(writer.calls).toEqual([
      { token: "secret", taskId: "222", parentId: "456" },
    ]);
  });

  test("promotes a subtask to a top-level task", async () => {
    const writer = new RecordingParentWriter();
    const prepared = prepareTaskParentUpdate("222", { parent: "null" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);

    const result = await executeTaskParentUpdate("secret", prepared.value, {
      writer,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        task: { gid: "222", name: "Moved" },
        applied: { parent: null },
      },
    });
    expect(writer.calls).toEqual([
      { token: "secret", taskId: "222", parentId: null },
    ]);
  });

  test("propagates gateway failures without leaking details", async () => {
    const writer = new RecordingParentWriter(
      err({ kind: "not_found", status: 404, message: "Task not found" }),
    );
    const result = await executeTaskParentUpdate(
      "secret",
      { taskId: "222", parentId: "456" },
      { writer },
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: "not_found", status: 404, message: "Task not found" },
    });
    expect(writer.calls).toHaveLength(1);
  });
});

describe("task creation preparation", () => {
  test("requires a landing target and name", () => {
    expect(prepareTaskCreate({ name: "Child" })).toEqual({
      ok: false,
      error: {
        kind: "invalid_usage",
        message: "One of --parent, --my-section, or --project is required",
      },
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
        target: { kind: "subtask", parentId: "222" },
        mutation: {
          name: "Child",
          due_on: "2028-02-29",
          completed: false,
        },
        notesFile: "notes.md",
        resolveAssigneeMe: true,
        mySection: { kind: "alias", value: "in_progress" },
        customFields: [
          { field: { kind: "alias", value: "estimate" }, value: "4" },
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

  test("prepares a standalone project task", () => {
    expect(prepareTaskCreate({ project: "456", name: "Top level" })).toEqual({
      ok: true,
      value: {
        target: { kind: "project", projectGid: "456" },
        mutation: { name: "Top level" },
        resolveAssigneeMe: false,
        customFields: [],
      },
    });
  });

  test("rejects ambiguous landing targets", () => {
    expect(
      prepareTaskCreate({ parent: "123", project: "456", name: "Task" }),
    ).toEqual({
      ok: false,
      error: {
        kind: "invalid_usage",
        message: "--parent and --project are mutually exclusive",
      },
    });
    expect(
      prepareTaskCreate({
        project: "456",
        mySection: "@todo",
        name: "Task",
      }),
    ).toEqual({
      ok: false,
      error: {
        kind: "invalid_usage",
        message: "--project and --my-section are mutually exclusive",
      },
    });
  });
});

describe("prepareTaskCreateWithConfig", () => {
  const optionsWithMySection = {
    parent: "123",
    name: "Child",
    mySection: "300",
  } as const;

  test("applies validated me and GID defaults", async () => {
    const ownTask = await prepareTaskCreateWithConfig(
      optionsWithMySection,
      async () => ok({ defaultAssignee: "me" }),
    );
    expect(ownTask.ok && ownTask.value.resolveAssigneeMe).toBe(true);

    const delegatedTask = await prepareTaskCreateWithConfig(
      optionsWithMySection,
      async () => ok({ defaultAssignee: "9001" }),
    );
    expect(delegatedTask.ok && delegatedTask.value.mutation.assignee).toBe(
      "9001",
    );
  });

  test("never resolves a default for an explicit assignee", async () => {
    for (const assignee of ["me", "9001", "null"] as const) {
      let resolverCalls = 0;
      const prepared = await prepareTaskCreateWithConfig(
        { parent: "123", name: "Child", assignee },
        async () => {
          resolverCalls += 1;
          return ok({ defaultAssignee: "8002" });
        },
      );
      expect(prepared.ok).toBe(true);
      expect(resolverCalls).toBe(0);
    }
  });

  test("keeps an explicit null from satisfying the My Tasks precondition", async () => {
    let resolverCalls = 0;
    const prepared = await prepareTaskCreateWithConfig(
      { ...optionsWithMySection, assignee: "null" },
      async () => {
        resolverCalls += 1;
        return ok({ defaultAssignee: "me" });
      },
    );
    expect(prepared.ok).toBe(false);
    expect(resolverCalls).toBe(0);
  });

  test("rejects an invalid resolved default", async () => {
    const prepared = await prepareTaskCreateWithConfig(
      { parent: "123", name: "Child" },
      async () => ok({ defaultAssignee: "not-a-gid" }),
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
    const prepared = await prepareTaskCreateWithConfig(
      { parent: "123", name: "Child" },
      async () => err({ kind: "configuration", message: "invalid config" }),
    );
    expect(prepared).toEqual({
      ok: false,
      error: { kind: "configuration", message: "invalid config" },
    });
  });

  test("uses the configured workspace for a My Tasks task", async () => {
    const prepared = await prepareTaskCreateWithConfig(
      { name: "Standalone", mySection: "@todo", assignee: "me" },
      async () => ok({ workspaceGid: "700" }),
    );

    expect(prepared.ok && prepared.value.target).toEqual({
      kind: "workspace",
      workspaceGid: "700",
    });
  });

  test("requires a configured workspace for a My Tasks task", async () => {
    const prepared = await prepareTaskCreateWithConfig(
      { name: "Standalone", mySection: "@todo", assignee: "me" },
      async () => ok({}),
    );

    expect(prepared).toEqual({
      ok: false,
      error: {
        kind: "configuration",
        message: "workspace.gid is required to create a task in My Tasks",
      },
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
    expect(creator.calls[0]?.target).toEqual({
      kind: "subtask",
      parentId: "123",
    });
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
          message: "Task writer is required for staged task mutations",
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
      customFields: [
        { field: { kind: "alias", value: "estimate" }, value: "4" },
      ],
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

describe("selected response fields", () => {
  class FieldRecordingWriter implements TaskMutationGateway {
    calls: Array<readonly string[] | undefined> = [];

    async updateTask(
      _token: string,
      taskId: string,
      _mutation: TaskMutation,
      fields?: readonly string[],
    ) {
      this.calls.push(fields);
      return ok({ gid: taskId });
    }
  }

  class FieldRecordingCreator implements TaskCreationGateway {
    calls: Array<readonly string[] | undefined> = [];

    async createTask(
      _token: string,
      _target: TaskCreationTarget,
      _mutation: TaskMutation,
      fields?: readonly string[],
    ) {
      this.calls.push(fields);
      return ok({ gid: "77" });
    }
  }

  const materialization = {
    resolveAuthenticatedUserGid: async () => ok("1001"),
    readFile: async () => "",
    readStdin: async () => "",
  };

  test("prepareTaskUpdate keeps fields out of the mutation payload", () => {
    const prepared = prepareTaskUpdate("123", { name: "New" }, "due_on");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.fields).toEqual(["due_on"]);
    expect(prepared.value.mutation).toEqual({ name: "New" });
  });

  test("prepareTaskUpdate still requires at least one mutation", () => {
    expect(prepareTaskUpdate("123", {}, "due_on")).toEqual(
      err({
        kind: "invalid_usage",
        message: "At least one task mutation is required",
      }),
    );
  });

  test.each(["", " ", ",", "name,,notes"])(
    "prepareTaskUpdate rejects malformed fields %p",
    (fields) => {
      const prepared = prepareTaskUpdate("123", { name: "New" }, fields);
      expect(prepared.ok).toBe(false);
      if (prepared.ok) return;
      expect(prepared.error.kind).toBe("invalid_usage");
    },
  );

  test("prepareTaskParentUpdate carries fields without tripping exclusivity", () => {
    const prepared = prepareTaskParentUpdate("123", { parent: "9" }, "name");
    expect(prepared).toEqual(
      ok({ taskId: "123", parentId: "9", fields: ["name"] }),
    );
  });

  test("prepareTaskParentUpdate carries fields when promoting to null", () => {
    expect(prepareTaskParentUpdate("123", { parent: "null" }, "name")).toEqual(
      ok({ taskId: "123", parentId: null, fields: ["name"] }),
    );
  });

  test("executeTaskParentUpdate forwards fields to the gateway", async () => {
    const calls: Array<readonly string[] | undefined> = [];
    const writer: TaskParentMutationGateway = {
      async setTaskParent(_token, taskId, _parentId, fields) {
        calls.push(fields);
        return ok({ gid: taskId });
      },
    };
    await executeTaskParentUpdate(
      "token",
      { taskId: "123", parentId: "9", fields: ["name"] },
      { writer },
    );
    expect(calls).toEqual([["name"]]);
  });

  test("executeTaskUpdate forwards fields to the gateway", async () => {
    const writer = new FieldRecordingWriter();
    await executeTaskUpdate(
      "token",
      {
        taskId: "123",
        mutation: { name: "New" },
        resolveAssigneeMe: false,
        customFields: [],
        fields: ["due_on"],
      },
      { writer, ...materialization },
    );
    expect(writer.calls).toEqual([["due_on"]]);
  });

  test("executeTaskUpdate sends no fields when none are selected", async () => {
    const writer = new FieldRecordingWriter();
    await executeTaskUpdate(
      "token",
      {
        taskId: "123",
        mutation: { name: "New" },
        resolveAssigneeMe: false,
        customFields: [],
      },
      { writer, ...materialization },
    );
    expect(writer.calls).toEqual([undefined]);
  });

  test("executeTaskCreation forwards fields to create and staged writes", async () => {
    const creator = new FieldRecordingCreator();
    const writer = new FieldRecordingWriter();
    const result = await executeTaskCreation(
      "token",
      {
        target: { kind: "subtask", parentId: "9" },
        mutation: { name: "Task", assignee: "4242" },
        resolveAssigneeMe: false,
        customFields: [],
        fields: ["name"],
      },
      { creator, writer, ...materialization },
    );

    expect(result.ok).toBe(true);
    expect(creator.calls).toEqual([["name"]]);
    expect(writer.calls).toEqual([["name"]]);
  });

  test("prepareTaskCreate carries fields into the prepared create", () => {
    const prepared = prepareTaskCreate({ name: "Task", parent: "9" }, "due_on");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.fields).toEqual(["due_on"]);
  });

  test("prepareTaskCreateWithConfig validates fields before reading config", async () => {
    let configReads = 0;
    const prepared = await prepareTaskCreateWithConfig(
      { name: "Task" },
      async () => {
        configReads += 1;
        return ok({ workspaceGid: "5" });
      },
      ",",
    );

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.kind).toBe("invalid_usage");
    expect(configReads).toBe(0);
  });
});

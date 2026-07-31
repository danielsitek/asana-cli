import { describe, expect, test } from "bun:test";

import { err, ok } from "../shared/result.ts";
import {
  DEFAULT_FIELDS,
  parseTaskId,
  updateTask,
  validateFieldList,
  type TaskMutation,
  type TaskMutationGateway,
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
  overrides: Partial<Parameters<typeof updateTask>[3]> = {},
): Parameters<typeof updateTask>[3] => ({
  writer,
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

describe("updateTask", () => {
  test.each([
    ["invalid identifier", "not-a-gid", { name: "x" }],
    ["no mutation", "123", {}],
    ["conflicting notes", "123", { notes: "x", notesFile: "x.md" }],
    ["invalid assignee", "123", { assignee: "ada@example.com" }],
    ["invalid date shape", "123", { dueOn: "31-12-2026" }],
    ["impossible date", "123", { dueOn: "2026-02-29" }],
    ["invalid completed", "123", { completed: "yes" }],
  ])("rejects %s without a write", async (_, taskId, options) => {
    const writer = new RecordingWriter();
    const result = await updateTask(
      "secret",
      taskId,
      options,
      dependenciesFor(writer),
    );

    expect(result.ok).toBe(false);
    expect(writer.calls).toHaveLength(0);
  });

  test("builds all supported mutations and resolves me before writing", async () => {
    const writer = new RecordingWriter();
    const result = await updateTask(
      "secret",
      "https://app.asana.com/0/111/222",
      {
        name: "Renamed",
        notes: "Replacement",
        assignee: "me",
        dueOn: "2028-02-29",
        completed: "false",
      },
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
      await updateTask(
        "secret",
        "123",
        { notesFile },
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
    await updateTask(
      "secret",
      "123",
      { assignee: "null", dueOn: "null", completed: "true" },
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
    const unreadable = await updateTask(
      "secret",
      "123",
      { notesFile: "missing.md" },
      dependenciesFor(writer, {
        readFile: async () => {
          throw new Error("sensitive path");
        },
      }),
    );
    const unresolved = await updateTask(
      "secret",
      "123",
      { assignee: "me" },
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
});

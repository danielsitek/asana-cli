import { describe, expect, test } from "bun:test";

import { err, ok, type Result } from "../shared/result.ts";
import type { TaskReadError } from "../tasks/index.ts";
import {
  DEFAULT_COMMENT_FIELDS,
  executeTaskCommentCreate,
  executeTaskCommentsRead,
  prepareTaskCommentCreate,
  prepareTaskCommentsRead,
  type Comment,
  type PreparedTaskCommentsRead,
  type TaskCommentCreationGateway,
  type TaskStoryGateway,
} from "./index.ts";

const story = (
  index: number,
  subtype: string,
  extra: Readonly<Record<string, unknown>> = {},
): Comment => ({
  gid: `${index}`,
  created_at: `2024-01-0${index}T00:00:00.000Z`,
  text: `comment ${index}`,
  created_by: { gid: "u1", name: "Ada" },
  resource_subtype: subtype,
  ...extra,
});

class QueuedReader implements TaskStoryGateway {
  calls: Array<
    Readonly<{ fields: readonly string[]; limit: number; offset?: string }>
  > = [];

  constructor(
    private readonly pages: readonly Result<
      Readonly<{ stories: readonly Comment[]; nextOffset?: string }>,
      TaskReadError
    >[],
  ) {}

  async getTaskStories(
    _token: string,
    _taskId: string,
    options: Readonly<{
      fields: readonly string[];
      limit: number;
      offset?: string;
    }>,
  ) {
    this.calls.push(options);
    const page = this.pages[this.calls.length - 1];
    if (!page) throw new Error("no more pages queued");
    return page;
  }
}

class RecordingWriter implements TaskCommentCreationGateway {
  calls: Array<
    Readonly<{
      token: string;
      taskId: string;
      text: string;
      fields: readonly string[];
    }>
  > = [];

  constructor(
    private readonly response: Result<Comment, TaskReadError> = ok({
      gid: "1",
      created_at: "2024-01-01T00:00:00.000Z",
      text: "hi",
      created_by: { gid: "u1", name: "Ada" },
    }),
  ) {}

  async createTaskComment(
    token: string,
    taskId: string,
    text: string,
    fields: readonly string[],
  ) {
    this.calls.push({ token, taskId, text, fields });
    return this.response;
  }
}

describe("prepareTaskCommentsRead", () => {
  test("defaults fields, scan cap, and result cap", () => {
    const prepared = prepareTaskCommentsRead("123", {});
    expect(prepared).toEqual({
      ok: true,
      value: {
        taskId: "123",
        outputFields: DEFAULT_COMMENT_FIELDS,
        requestFields: [...DEFAULT_COMMENT_FIELDS, "resource_subtype"],
        scanCap: 100,
        mode: { kind: "capped", resultCap: 20 },
      },
    });
  });

  test("never duplicates resource_subtype when explicitly requested in --fields", () => {
    const prepared = prepareTaskCommentsRead("123", {
      fields: "gid,resource_subtype",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.outputFields).toEqual(["gid", "resource_subtype"]);
    expect(prepared.value.requestFields).toEqual(["gid", "resource_subtype"]);
  });

  test("rejects invalid task id before any other validation", () => {
    const prepared = prepareTaskCommentsRead("not-a-gid", { max: "abc" });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.message).toContain("Invalid task identifier");
  });

  test("rejects invalid --fields", () => {
    const prepared = prepareTaskCommentsRead("123", { fields: "gid,,text" });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.message).toContain("empty segments");
  });

  test("rejects empty --offset", () => {
    const prepared = prepareTaskCommentsRead("123", { offset: "" });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.message).toBe("--offset cannot be empty");
  });

  test("--all requires --max", () => {
    const prepared = prepareTaskCommentsRead("123", { all: true });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.message).toBe("--all requires --max");
  });

  test("--all with --max removes the result cap", () => {
    const prepared = prepareTaskCommentsRead("123", { max: "5", all: true });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.scanCap).toBe(5);
    expect(prepared.value.mode).toEqual({ kind: "all" });
  });

  test("--max without --all keeps the default result cap", () => {
    const prepared = prepareTaskCommentsRead("123", { max: "50" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.scanCap).toBe(50);
    expect(prepared.value.mode).toEqual({
      kind: "capped",
      resultCap: 20,
    });
  });

  test("--max must be a positive safe integer", () => {
    for (const invalid of ["0", "-1", "1.5", "abc", "9007199254740992"]) {
      const prepared = prepareTaskCommentsRead("123", { max: invalid });
      expect(prepared.ok).toBe(false);
      if (prepared.ok) continue;
      expect(prepared.error.message).toBe(
        "--max must be a positive safe integer",
      );
    }
  });

  test("propagates a non-empty --offset", () => {
    const prepared = prepareTaskCommentsRead("123", { offset: "opaque-token" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.mode).toEqual({
      kind: "capped",
      resultCap: 20,
      offset: "opaque-token",
    });
  });

  test("--latest requires --max", () => {
    const prepared = prepareTaskCommentsRead("123", { latest: "3" });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.message).toBe("--latest requires --max");
  });

  test("--latest and --all are mutually exclusive", () => {
    const prepared = prepareTaskCommentsRead("123", {
      latest: "3",
      max: "10",
      all: true,
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.message).toBe(
      "--latest and --all are mutually exclusive",
    );
  });

  test("--latest and --offset are mutually exclusive", () => {
    const prepared = prepareTaskCommentsRead("123", {
      latest: "3",
      max: "10",
      offset: "opaque-token",
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.message).toBe(
      "--latest and --offset are mutually exclusive",
    );
  });

  test("--latest must be a positive safe integer", () => {
    for (const invalid of ["0", "-1", "1.5", "abc", "9007199254740992"]) {
      const prepared = prepareTaskCommentsRead("123", {
        latest: invalid,
        max: "10",
      });
      expect(prepared.ok).toBe(false);
      if (prepared.ok) continue;
      expect(prepared.error.message).toBe(
        "--latest must be a positive safe integer",
      );
    }
  });

  test("--latest with --max removes the result cap and sets latest", () => {
    const prepared = prepareTaskCommentsRead("123", {
      latest: "3",
      max: "10",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.mode).toEqual({ kind: "latest", count: 3 });
    expect(prepared.value.scanCap).toBe(10);
  });
});

describe("executeTaskCommentsRead", () => {
  const prepared = (
    overrides: Partial<PreparedTaskCommentsRead> = {},
  ): PreparedTaskCommentsRead => ({
    taskId: "123",
    outputFields: DEFAULT_COMMENT_FIELDS,
    requestFields: [...DEFAULT_COMMENT_FIELDS, "resource_subtype"],
    scanCap: 100,
    mode: { kind: "capped", resultCap: 20 },
    ...overrides,
  });

  const preparedLatest = (
    latest: number,
    scanCap: number,
    overrides: Partial<PreparedTaskCommentsRead> = {},
  ): PreparedTaskCommentsRead => {
    return {
      ...prepared(overrides),
      scanCap,
      mode: { kind: "latest", count: latest },
    };
  };

  test("filters to resource_subtype=comment_added only", async () => {
    const reader = new QueuedReader([
      ok({
        stories: [
          story(1, "comment_added"),
          story(2, "assigned"),
          story(3, "comment_added"),
        ],
      }),
    ]);
    const result = await executeTaskCommentsRead("t", prepared(), { reader });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comments.map((c) => c.gid)).toEqual(["1", "3"]);
    expect(result.value.meta).toEqual({
      scanned: 3,
      returned: 2,
      scan_truncated: false,
    });
  });

  test("projects only requested output fields and drops resource_subtype", async () => {
    const reader = new QueuedReader([
      ok({ stories: [story(1, "comment_added")] }),
    ]);
    const result = await executeTaskCommentsRead(
      "t",
      prepared({
        outputFields: ["gid", "text"],
        requestFields: ["gid", "text", "resource_subtype"],
      }),
      { reader },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comments).toEqual([{ gid: "1", text: "comment 1" }]);
  });

  test("result cap does not claim the story scan was truncated", async () => {
    const reader = new QueuedReader([
      ok({
        stories: [
          story(1, "comment_added"),
          story(2, "comment_added"),
          story(3, "comment_added"),
        ],
      }),
    ]);
    const result = await executeTaskCommentsRead(
      "t",
      prepared({ mode: { kind: "capped", resultCap: 2 } }),
      { reader },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comments).toHaveLength(2);
    expect(result.value.meta).toEqual({
      scanned: 2,
      returned: 2,
      scan_truncated: false,
    });
    expect(result.value.meta.next_offset).toBeUndefined();
  });

  test("returns at most 20 comments by default", async () => {
    const reader = new QueuedReader([
      ok({
        stories: Array.from({ length: 21 }, (_, index) =>
          story(index + 1, "comment_added"),
        ),
      }),
    ]);
    const result = await executeTaskCommentsRead("t", prepared(), { reader });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comments).toHaveLength(20);
    expect(result.value.meta).toEqual({
      scanned: 20,
      returned: 20,
      scan_truncated: false,
    });
  });

  test("stops at result cap at page end and surfaces next_offset", async () => {
    const reader = new QueuedReader([
      ok({
        stories: [story(1, "comment_added"), story(2, "comment_added")],
        nextOffset: "page-2",
      }),
    ]);
    const result = await executeTaskCommentsRead(
      "t",
      prepared({ mode: { kind: "capped", resultCap: 2 } }),
      { reader },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meta.scan_truncated).toBe(false);
    expect(result.value.meta.next_offset).toBe("page-2");
  });

  test("marks truncation when result and story caps are reached together", async () => {
    const reader = new QueuedReader([
      ok({
        stories: [
          story(1, "comment_added"),
          story(2, "comment_added"),
          story(3, "comment_added"),
        ],
      }),
    ]);
    const result = await executeTaskCommentsRead(
      "t",
      prepared({
        mode: { kind: "capped", resultCap: 2 },
        scanCap: 2,
      }),
      { reader },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meta).toEqual({
      scanned: 2,
      returned: 2,
      scan_truncated: true,
    });
  });

  test("paginates across pages using nextOffset until the scan cap", async () => {
    const reader = new QueuedReader([
      ok({ stories: [story(1, "comment_added")], nextOffset: "page-2" }),
      ok({ stories: [story(2, "comment_added")] }),
    ]);
    const result = await executeTaskCommentsRead("t", prepared(), { reader });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comments).toHaveLength(2);
    expect(reader.calls[1]?.offset).toBe("page-2");
    expect(result.value.meta.scan_truncated).toBe(false);
  });

  test("treats an empty terminal page as source exhaustion", async () => {
    const reader = new QueuedReader([ok({ stories: [] })]);
    const result = await executeTaskCommentsRead("t", prepared(), { reader });
    expect(result).toEqual({
      ok: true,
      value: {
        comments: [],
        meta: { scanned: 0, returned: 0, scan_truncated: false },
      },
    });
    expect(reader.calls).toHaveLength(1);
  });

  test("rejects an empty page that claims a next offset", async () => {
    const reader = new QueuedReader([
      ok({ stories: [], nextOffset: "unique-next-page" }),
    ]);
    const result = await executeTaskCommentsRead("t", prepared(), { reader });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Story pagination did not advance",
      },
    });
    expect(reader.calls).toHaveLength(1);
  });

  test("rejects a non-advancing offset after a non-empty page", async () => {
    const reader = new QueuedReader([
      ok({ stories: [story(1, "assigned")], nextOffset: "same-page" }),
    ]);
    const result = await executeTaskCommentsRead(
      "t",
      prepared({
        mode: { kind: "capped", resultCap: 20, offset: "same-page" },
      }),
      { reader },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Story pagination did not advance",
      },
    });
    expect(reader.calls).toHaveLength(1);
  });

  test("rejects an offset cycle before requesting a duplicate page", async () => {
    const reader = new QueuedReader([
      ok({
        stories: [story(1, "assigned")],
        nextOffset: "second-page",
      }),
      ok({ stories: [story(2, "assigned")], nextOffset: "first-page" }),
    ]);
    const result = await executeTaskCommentsRead(
      "t",
      prepared({
        mode: { kind: "capped", resultCap: 20, offset: "first-page" },
      }),
      { reader },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Story pagination did not advance",
      },
    });
    expect(reader.calls).toHaveLength(2);
  });

  test("marks scan_truncated when the scan cap is hit and more stories are known", async () => {
    const reader = new QueuedReader([
      ok({
        stories: [story(1, "assigned"), story(2, "assigned")],
        nextOffset: "page-2",
      }),
    ]);
    const result = await executeTaskCommentsRead(
      "t",
      prepared({ scanCap: 2 }),
      { reader },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meta).toEqual({
      scanned: 2,
      returned: 0,
      scan_truncated: true,
      next_offset: "page-2",
    });
  });

  test("does not mark scan_truncated when source stories are exhausted", async () => {
    const reader = new QueuedReader([ok({ stories: [story(1, "assigned")] })]);
    const result = await executeTaskCommentsRead(
      "t",
      prepared({ scanCap: 100 }),
      { reader },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meta.scan_truncated).toBe(false);
  });

  test("caps each request limit at 100", async () => {
    const reader = new QueuedReader([ok({ stories: [] })]);
    await executeTaskCommentsRead("t", prepared({ scanCap: 250 }), { reader });
    expect(reader.calls[0]?.limit).toBe(100);
  });

  test("never processes stories beyond the remaining scan budget", async () => {
    const reader = new QueuedReader([
      ok({ stories: [story(1, "assigned")], nextOffset: "page-2" }),
      ok({
        stories: [
          story(2, "assigned"),
          story(3, "comment_added"),
          story(4, "comment_added"),
        ],
        nextOffset: "page-3",
      }),
    ]);
    const result = await executeTaskCommentsRead(
      "t",
      {
        taskId: "123",
        outputFields: DEFAULT_COMMENT_FIELDS,
        requestFields: [...DEFAULT_COMMENT_FIELDS, "resource_subtype"],
        scanCap: 3,
        mode: { kind: "all" },
      },
      { reader },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(reader.calls.map((call) => call.limit)).toEqual([3, 2]);
    expect(result.value.comments.map((comment) => comment.gid)).toEqual(["3"]);
    expect(result.value.meta).toEqual({
      scanned: 3,
      returned: 1,
      scan_truncated: true,
    });
  });

  test("keeps an explicitly requested discriminator and custom nested leaf", async () => {
    const reader = new QueuedReader([
      ok({
        stories: [
          story(1, "comment_added", {
            created_by: { gid: "u1", name: "Ada", email: "ada@example.com" },
          }),
        ],
      }),
    ]);
    const result = await executeTaskCommentsRead(
      "t",
      prepared({
        outputFields: ["resource_subtype", "created_by.email"],
        requestFields: ["resource_subtype", "created_by.email"],
      }),
      { reader },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comments).toEqual([
      {
        resource_subtype: "comment_added",
        created_by: { email: "ada@example.com" },
      },
    ]);
  });

  test("propagates reader errors", async () => {
    const reader = new QueuedReader([
      err({ kind: "not_found", message: "Task not found", status: 404 }),
    ]);
    const result = await executeTaskCommentsRead("t", prepared(), { reader });
    expect(result).toEqual({
      ok: false,
      error: { kind: "not_found", message: "Task not found", status: 404 },
    });
  });

  describe("--latest mode", () => {
    test("latest=1 across mixed multi-page stories returns only the final comment", async () => {
      const reader = new QueuedReader([
        ok({
          stories: [
            story(1, "comment_added"),
            story(2, "assigned"),
            story(3, "comment_added"),
          ],
          nextOffset: "page-2",
        }),
        ok({ stories: [story(4, "assigned"), story(5, "comment_added")] }),
      ]);
      const result = await executeTaskCommentsRead(
        "t",
        preparedLatest(1, 100),
        { reader },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.comments.map((c) => c.gid)).toEqual(["5"]);
      expect(result.value.meta).toEqual({
        scanned: 5,
        returned: 1,
        scan_truncated: false,
      });
    });

    test("latest=3 returns up to three newest-first, bounding retained comments", async () => {
      const reader = new QueuedReader([
        ok({
          stories: Array.from({ length: 30 }, (_, index) =>
            story(index + 1, "comment_added"),
          ),
        }),
      ]);
      const result = await executeTaskCommentsRead(
        "t",
        preparedLatest(3, 100),
        { reader },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.comments.map((c) => c.gid)).toEqual([
        "30",
        "29",
        "28",
      ]);
      expect(result.value.meta).toEqual({
        scanned: 30,
        returned: 3,
        scan_truncated: false,
      });
    });

    test("projects custom fields strictly in latest mode", async () => {
      const reader = new QueuedReader([
        ok({
          stories: [
            story(1, "comment_added"),
            story(2, "comment_added", {
              created_by: { gid: "u1", name: "Ada", email: "ada@example.com" },
            }),
          ],
        }),
      ]);
      const result = await executeTaskCommentsRead(
        "t",
        preparedLatest(1, 100, {
          outputFields: ["gid", "created_by.email"],
          requestFields: ["gid", "created_by.email", "resource_subtype"],
        }),
        { reader },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.comments).toEqual([
        { gid: "2", created_by: { email: "ada@example.com" } },
      ]);
    });

    test("returns zero comments when the source is exhausted with none", async () => {
      const reader = new QueuedReader([
        ok({ stories: [story(1, "assigned")] }),
      ]);
      const result = await executeTaskCommentsRead(
        "t",
        preparedLatest(5, 100),
        { reader },
      );
      expect(result).toEqual({
        ok: true,
        value: {
          comments: [],
          meta: { scanned: 1, returned: 0, scan_truncated: false },
        },
      });
    });

    test("returns fewer than N when fewer comments exist before exhaustion", async () => {
      const reader = new QueuedReader([
        ok({
          stories: [story(1, "comment_added"), story(2, "comment_added")],
        }),
      ]);
      const result = await executeTaskCommentsRead(
        "t",
        preparedLatest(5, 100),
        { reader },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.comments.map((c) => c.gid)).toEqual(["2", "1"]);
      expect(result.value.meta).toEqual({
        scanned: 2,
        returned: 2,
        scan_truncated: false,
      });
    });

    test("succeeds on exact exhaustion at the scan cap", async () => {
      const reader = new QueuedReader([
        ok({
          stories: [story(1, "comment_added"), story(2, "comment_added")],
        }),
      ]);
      const result = await executeTaskCommentsRead("t", preparedLatest(5, 2), {
        reader,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.comments.map((c) => c.gid)).toEqual(["2", "1"]);
      expect(result.value.meta).toEqual({
        scanned: 2,
        returned: 2,
        scan_truncated: false,
      });
    });

    test("fails with scan_limit and no data when the cap ends mid-page", async () => {
      const reader = new QueuedReader([
        ok({
          stories: [
            story(1, "comment_added"),
            story(2, "comment_added"),
            story(3, "comment_added"),
          ],
        }),
      ]);
      const result = await executeTaskCommentsRead("t", preparedLatest(1, 2), {
        reader,
      });
      expect(result).toEqual({
        ok: false,
        error: {
          kind: "scan_limit",
          message:
            "Reached --max=2 before confirming the newest 1 comment(s); rerun with a higher --max",
        },
      });
    });

    test("fails with scan_limit and no data when nextOffset proves more stories at cap", async () => {
      const reader = new QueuedReader([
        ok({
          stories: [story(1, "comment_added"), story(2, "comment_added")],
          nextOffset: "page-2",
        }),
      ]);
      const result = await executeTaskCommentsRead("t", preparedLatest(1, 2), {
        reader,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toEqual({
        kind: "scan_limit",
        message:
          "Reached --max=2 before confirming the newest 1 comment(s); rerun with a higher --max",
      });
    });

    test("propagates reader errors before any scan_limit determination", async () => {
      const reader = new QueuedReader([
        err({ kind: "rate_limit", message: "Retries exhausted" }),
      ]);
      const result = await executeTaskCommentsRead("t", preparedLatest(1, 2), {
        reader,
      });
      expect(result).toEqual({
        ok: false,
        error: { kind: "rate_limit", message: "Retries exhausted" },
      });
    });
  });
});

describe("prepareTaskCommentCreate", () => {
  test("accepts positional text", () => {
    const prepared = prepareTaskCommentCreate("123", { text: "hello" });
    expect(prepared).toEqual({
      ok: true,
      value: {
        taskId: "123",
        outputFields: DEFAULT_COMMENT_FIELDS,
        text: "hello",
      },
    });
  });

  test("accepts --file", () => {
    const prepared = prepareTaskCommentCreate("123", { file: "note.txt" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.file).toBe("note.txt");
  });

  test("accepts --file=-", () => {
    const prepared = prepareTaskCommentCreate("123", { file: "-" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.file).toBe("-");
  });

  test("rejects both positional text and --file", () => {
    const prepared = prepareTaskCommentCreate("123", {
      text: "hi",
      file: "note.txt",
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.message).toContain("mutually exclusive");
  });

  test("rejects neither positional text nor --file", () => {
    const prepared = prepareTaskCommentCreate("123", {});
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.message).toContain("required");
  });

  test("rejects empty positional text", () => {
    const prepared = prepareTaskCommentCreate("123", { text: "" });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.message).toBe("Comment text cannot be empty");
  });

  test("rejects empty --file", () => {
    const prepared = prepareTaskCommentCreate("123", { file: "" });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.message).toBe("--file cannot be empty");
  });

  test("rejects invalid task id before checking text/file", () => {
    const prepared = prepareTaskCommentCreate("not-a-gid", {});
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.message).toContain("Invalid task identifier");
  });
});

describe("executeTaskCommentCreate", () => {
  test("posts positional text verbatim without touching the filesystem or stdin", async () => {
    const writer = new RecordingWriter();
    const readFile = () => {
      throw new Error("should not read a file");
    };
    const readStdin = () => {
      throw new Error("should not read stdin");
    };
    const result = await executeTaskCommentCreate(
      "token",
      { taskId: "123", outputFields: DEFAULT_COMMENT_FIELDS, text: "hello" },
      { writer, readFile, readStdin },
    );
    expect(result.ok).toBe(true);
    expect(writer.calls).toEqual([
      {
        token: "token",
        taskId: "123",
        text: "hello",
        fields: DEFAULT_COMMENT_FIELDS,
      },
    ]);
  });

  test("reads --file verbatim, rejecting empty file content", async () => {
    const writer = new RecordingWriter();
    const result = await executeTaskCommentCreate(
      "token",
      { taskId: "123", outputFields: DEFAULT_COMMENT_FIELDS, file: "note.txt" },
      {
        writer,
        readFile: async () => "",
        readStdin: async () => {
          throw new Error("should not read stdin");
        },
      },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "invalid_usage", message: "Comment text cannot be empty" },
    });
    expect(writer.calls).toHaveLength(0);
  });

  test("reads stdin verbatim for --file=-", async () => {
    const writer = new RecordingWriter();
    const result = await executeTaskCommentCreate(
      "token",
      { taskId: "123", outputFields: DEFAULT_COMMENT_FIELDS, file: "-" },
      {
        writer,
        readFile: async () => {
          throw new Error("should not read a file");
        },
        readStdin: async () => "from stdin",
      },
    );
    expect(result.ok).toBe(true);
    expect(writer.calls[0]?.text).toBe("from stdin");
  });

  test("surfaces file read failures before any POST", async () => {
    const writer = new RecordingWriter();
    const result = await executeTaskCommentCreate(
      "token",
      {
        taskId: "123",
        outputFields: DEFAULT_COMMENT_FIELDS,
        file: "missing.txt",
      },
      {
        writer,
        readFile: async () => {
          throw new Error("ENOENT");
        },
        readStdin: async () => "",
      },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "invalid_usage", message: "Unable to read comment file" },
    });
    expect(writer.calls).toHaveLength(0);
  });

  test("projects the created comment to the requested fields", async () => {
    const writer = new RecordingWriter(
      ok({
        gid: "9",
        created_at: "2024-01-01T00:00:00.000Z",
        text: "hi",
        created_by: { gid: "u1", name: "Ada" },
        resource_subtype: "comment_added",
      }),
    );
    const result = await executeTaskCommentCreate(
      "token",
      { taskId: "123", outputFields: ["gid", "text"], text: "hi" },
      { writer, readFile: async () => "", readStdin: async () => "" },
    );
    expect(result).toEqual({ ok: true, value: { gid: "9", text: "hi" } });
  });
});

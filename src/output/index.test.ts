import { describe, expect, test } from "bun:test";

import {
  renderJson,
  renderIdentity,
  renderResolvedMyTasks,
  renderError,
  renderConfigValue,
  renderConfig,
  renderTaskDetail,
  renderTaskUpdate,
  renderCommentList,
  renderCommentScanWarning,
  renderCommentDetail,
  renderWorkspaceList,
} from "./index.ts";

describe("configuration output", () => {
  test("renderJson prints standard JSON with trailing newline", () => {
    const data = { foo: "bar" };
    expect(renderJson(data)).toBe(JSON.stringify({ data, meta: {} }) + "\n");
    expect(renderJson(data, { version: "1" })).toBe(
      JSON.stringify({ data, meta: { version: "1" } }) + "\n",
    );
  });

  test("renderJson escapes newlines within a single line", () => {
    const data = { notes: "line 1\nline 2" };
    const result = renderJson(data);
    expect(result).toBe(JSON.stringify({ data, meta: {} }) + "\n");
    expect(result.split("\n")).toHaveLength(2);
  });

  test("renderIdentity formats identity correctly", () => {
    expect(renderIdentity({ gid: "123", name: "Alice" })).toBe(
      "gid: 123\nname: Alice\n",
    );
  });

  test("renderResolvedMyTasks formats task list and sorts sections and custom fields", () => {
    const myTasks = {
      userTaskListGid: "utl-1",
      sections: {
        "b-section": "sec-b",
        "a-section": "sec-a",
        same: "same-1",
      },
      customFields: {
        "y-field": "fld-y",
        "x-field": "fld-x",
        same: "same-2",
      },
    };
    const expected =
      [
        "userTaskListGid: utl-1",
        "sections:",
        "  a-section: sec-a",
        "  b-section: sec-b",
        "  same: same-1",
        "customFields:",
        "  same: same-2",
        "  x-field: fld-x",
        "  y-field: fld-y",
      ].join("\n") + "\n";
    expect(renderResolvedMyTasks(myTasks)).toBe(expected);
  });

  test("renderError renders compact JSON on a single line", () => {
    const err = { code: "ERR_1", message: "something failed" };
    expect(renderError(err)).toBe(JSON.stringify({ error: err }) + "\n");
  });

  test("renderError escapes embedded newlines within a single line", () => {
    const err = { code: "ERR_1", message: "line 1\nline 2" };
    const result = renderError(err);
    expect(result).toBe(JSON.stringify({ error: err }) + "\n");
    expect(result.split("\n")).toHaveLength(2);
  });

  test("renderConfigValue JSON output and multi-source rendering", () => {
    expect(
      renderConfigValue("val", { layer: "global", path: "/path" }, {}, true),
    ).toBe(renderJson("val", { source: { layer: "global", path: "/path" } }));

    expect(
      renderConfigValue("val", undefined, { foo: { layer: "shared" } }, true),
    ).toBe(renderJson("val", { sources: { foo: { layer: "shared" } } }));

    expect(renderConfigValue("val", undefined, {}, true)).toBe(
      renderJson("val", {}),
    );

    expect(
      renderConfigValue(
        "val",
        undefined,
        {
          b: { layer: "shared", path: "/shared" },
          a: { layer: "global" },
        },
        false,
      ),
    ).toBe("val\nsource a: global\nsource b: shared (/shared)\n");
  });

  test("renderConfig with JSON rendering", () => {
    expect(
      renderConfig({ foo: "bar" }, { foo: { layer: "global" } }, true, true),
    ).toBe(
      renderJson({ foo: "bar" }, { sources: { foo: { layer: "global" } } }),
    );

    expect(
      renderConfig({ foo: "bar" }, { foo: { layer: "global" } }, false, true),
    ).toBe(renderJson({ foo: "bar" }, {}));
  });

  test("renders null as an em dash and names source layers", () => {
    expect(
      renderConfig(
        { nullable: null },
        { nullable: { layer: "built-in" } },
        true,
        false,
      ),
    ).toBe("nullable: — [built-in]\n");

    expect(
      renderConfigValue(
        null,
        { layer: "local", path: "/repo/.asana-cli.local.json" },
        {},
        false,
      ),
    ).toBe(
      "—\nsource layer: local\nsource path: /repo/.asana-cli.local.json\n",
    );
  });

  test("renderTaskDetail formats task correctly with deterministic keys, multiline notes, and nulls", () => {
    const task = {
      gid: "1215978111726134",
      name: "Implement the change",
      completed: true,
      due_on: null,
      assignee: {
        gid: "12345",
        name: "Ada Lovelace",
      },
      notes: "This is line 1\nThis is line 2\nThis is line 3",
    };
    const expected =
      [
        "gid: 1215978111726134",
        "name: Implement the change",
        "completed: true",
        "due_on: —",
        "assignee.gid: 12345",
        "assignee.name: Ada Lovelace",
        "notes:",
        "  This is line 1",
        "  This is line 2",
        "  This is line 3",
      ].join("\n") + "\n";
    expect(renderTaskDetail(task)).toBe(expected);
  });

  test("renderTaskDetail formats assignee as null consistently", () => {
    const task = {
      gid: "121",
      name: "Task without assignee",
      assignee: null,
      notes: "",
    };
    const expected =
      [
        "gid: 121",
        "name: Task without assignee",
        "assignee: —",
        "notes: ",
      ].join("\n") + "\n";
    expect(renderTaskDetail(task)).toBe(expected);
  });

  test("renderTaskUpdate preserves task detail and appends applied changes", () => {
    expect(
      renderTaskUpdate(
        { gid: "123", name: "Updated" },
        { name: "Updated", custom_fields: { "400": null } },
      ),
    ).toBe(
      "gid: 123\n" +
        "name: Updated\n" +
        "applied:\n" +
        "  name: Updated\n" +
        "  custom_fields.400: —\n",
    );
  });
});

describe("comment output", () => {
  test("renderCommentList renders a borderless table with padded columns", () => {
    const comments = [
      { gid: "1", text: "hi", created_by: { gid: "u1", name: "Ada" } },
      { gid: "22", text: "hello there", created_by: { gid: "u2", name: "Bo" } },
    ];
    expect(
      renderCommentList(comments, ["gid", "text", "created_by.name"]),
    ).toBe(
      [
        "gid  text         created_by.name",
        "1    hi           Ada",
        "22   hello there  Bo",
      ].join("\n") + "\n",
    );
  });

  test("renderCommentList renders unavailable nested values as an em dash", () => {
    expect(
      renderCommentList(
        [{ gid: "1", created_by: null }],
        ["gid", "created_by.gid", "created_by.name"],
      ),
    ).toBe(
      ["gid  created_by.gid  created_by.name", "1    —               —"].join(
        "\n",
      ) + "\n",
    );
  });

  test("renderCommentScanWarning renders diagnostics only for truncation", () => {
    expect(renderCommentScanWarning(true)).toBe(
      "Warning: story scan cap reached; more comments may exist.\n",
    );
    expect(renderCommentScanWarning(false)).toBe("");
  });

  test("renderCommentDetail renders key/value detail like task detail", () => {
    expect(
      renderCommentDetail({ gid: "1", text: "hi", created_by: null }),
    ).toBe("gid: 1\ntext: hi\ncreated_by: —\n");
  });
});

describe("workspace output", () => {
  test("renderWorkspaceList renders a borderless table with padded columns", () => {
    const workspaces = [
      { gid: "1", name: "Acme" },
      { gid: "22", name: "Umbrella Corp" },
    ];
    expect(renderWorkspaceList(workspaces)).toBe(
      ["gid  name         ", "1    Acme", "22   Umbrella Corp"].join("\n") +
        "\n",
    );
  });

  test("renderWorkspaceList renders a header-only table for an empty list", () => {
    expect(renderWorkspaceList([])).toBe("gid  name\n");
  });
});

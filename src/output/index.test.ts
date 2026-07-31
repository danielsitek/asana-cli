import { describe, expect, test } from "bun:test";

import {
  renderJson,
  renderIdentity,
  renderResolvedMyTasks,
  renderError,
  renderConfigValue,
  renderConfig,
  renderTaskDetail,
} from "./index.ts";

describe("configuration output", () => {
  test("renderJson prints standard JSON with trailing newline", () => {
    const data = { foo: "bar" };
    expect(renderJson(data)).toBe(
      JSON.stringify({ data, meta: {} }, null, 2) + "\n",
    );
    expect(renderJson(data, { version: "1" })).toBe(
      JSON.stringify({ data, meta: { version: "1" } }, null, 2) + "\n",
    );
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

  test("renderError renders a formatted JSON error", () => {
    const err = { code: "ERR_1", message: "something failed" };
    expect(renderError(err)).toBe(
      JSON.stringify({ error: err }, null, 2) + "\n",
    );
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

  test("renderTaskDetail formats task correctly with sorted keys, multiline notes, and nulls", () => {
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
        "assignee.gid: 12345",
        "assignee.name: Ada Lovelace",
        "completed: true",
        "due_on: —",
        "gid: 1215978111726134",
        "name: Implement the change",
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
        "assignee: —",
        "gid: 121",
        "name: Task without assignee",
        "notes: ",
      ].join("\n") + "\n";
    expect(renderTaskDetail(task)).toBe(expected);
  });
});

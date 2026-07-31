import { describe, expect, test } from "bun:test";

import {
  renderJson,
  renderIdentity,
  renderResolvedMyTasks,
  renderError,
  renderConfigValue,
  renderConfig,
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
});

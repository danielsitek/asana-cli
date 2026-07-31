import { describe, expect, test } from "bun:test";

import { renderConfig, renderConfigValue } from "./index.ts";

describe("configuration output", () => {
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

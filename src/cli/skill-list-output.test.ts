import { describe, expect, test } from "bun:test";

import type {
  SkillAgentStatus,
  SkillInstallationStatus,
} from "../skill/index.ts";
import { renderSkillList, terminalColorsEnabled } from "./skill-list-output.ts";

const installation = (
  status: SkillInstallationStatus["status"],
  path: string,
) => ({ status, path }) as const;

const badgeCases: readonly SkillAgentStatus[] = [
  {
    agent: "claude-code",
    global: installation("current", "/hidden/global"),
    local: installation("absent", "/hidden/local"),
  },
  {
    agent: "codex",
    global: installation("absent", "/hidden/global"),
    local: installation("outdated", "/hidden/local"),
  },
  {
    agent: "copilot",
    global: installation("outdated", "/hidden/global"),
    local: installation("current", "/hidden/local"),
  },
  {
    agent: "cursor",
    global: installation("absent", "/hidden/global"),
    local: installation("absent", "/hidden/local"),
  },
];

describe("skill list output", () => {
  test("renders every badge combination without diagnostics or colors", () => {
    expect(renderSkillList(badgeCases, false)).toBe(`Available agents:

  claude-code
    Claude Code skill for Asana CLI
    [global: current]

  codex
    Codex skill for Asana CLI
    [local: outdated]

  copilot
    GitHub Copilot skill for Asana CLI
    [global: outdated, local: current]

  cursor
    Cursor skill for Asana CLI
    [not installed]
`);
  });

  test("styles the heading, descriptions, and badges when colors are enabled", () => {
    expect(renderSkillList(badgeCases, true)).toBe(
      "\u001B[1mAvailable agents:\u001B[22m\n\n" +
        "  claude-code\n" +
        "    \u001B[2mClaude Code skill for Asana CLI\u001B[22m\n" +
        "    \u001B[32m[global: current]\u001B[39m\n\n" +
        "  codex\n" +
        "    \u001B[2mCodex skill for Asana CLI\u001B[22m\n" +
        "    \u001B[32m[local: outdated]\u001B[39m\n\n" +
        "  copilot\n" +
        "    \u001B[2mGitHub Copilot skill for Asana CLI\u001B[22m\n" +
        "    \u001B[32m[global: outdated, local: current]\u001B[39m\n\n" +
        "  cursor\n" +
        "    \u001B[2mCursor skill for Asana CLI\u001B[22m\n" +
        "    \u001B[2m[not installed]\u001B[22m\n",
    );
  });

  test("identifies newer and foreign installations in human output", () => {
    expect(
      renderSkillList(
        [
          {
            agent: "claude-code",
            global: installation("newer", "/hidden/global"),
            local: installation("foreign", "/hidden/local"),
          },
        ],
        false,
      ),
    ).toContain("[global: newer, local: foreign]");
  });

  test("uses the product-specific description for every registered agent", () => {
    const statuses: readonly SkillAgentStatus[] = [
      ...badgeCases.slice(0, 4),
      {
        agent: "gemini",
        global: installation("absent", "global"),
        local: installation("absent", "local"),
      },
      {
        agent: "pi",
        global: installation("absent", "global"),
        local: installation("absent", "local"),
      },
      {
        agent: "universal",
        global: installation("absent", "global"),
        local: installation("absent", "local"),
      },
    ];
    const output = renderSkillList(statuses, false);

    expect(output).toContain("Antigravity (Gemini) skill for Asana CLI");
    expect(output).toContain("Pi skill for Asana CLI");
    expect(output).toContain("Universal agent skill for Asana CLI");
  });

  test("enables colors only for a capable terminal", () => {
    expect(terminalColorsEnabled(true, {})).toBe(true);
    expect(terminalColorsEnabled(false, {})).toBe(false);
    expect(terminalColorsEnabled(true, { NO_COLOR: "" })).toBe(false);
    expect(terminalColorsEnabled(true, { TERM: "dumb" })).toBe(false);
  });
});

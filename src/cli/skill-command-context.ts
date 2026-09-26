import type { Command } from "commander";

import { renderError, renderJson } from "../output/index.ts";
import type {
  SkillContext,
  SkillError,
  SkillMutation,
  SkillScope,
  SkillUpdateAllResult,
} from "../skill/index.ts";
import type { Execution } from "./contracts.ts";

export type SkillInvocation = Readonly<{
  context: SkillContext;
  json: boolean;
  colorsEnabled: boolean;
}>;

export type SkillCommandContext = Readonly<{
  skill: Command;
  beginCommand: () => SkillInvocation | undefined;
  complete: (execution: Execution) => void;
}>;

export const scopeFrom = (local?: boolean): SkillScope =>
  local ? "local" : "global";

export const renderSkillError = (error: SkillError): Execution => ({
  stdout: "",
  stderr: renderError({
    code:
      error.kind === "unknown_agent"
        ? "invalid_usage"
        : error.kind === "filesystem"
          ? "internal_error"
          : "invalid_state",
    message: error.message,
  }),
  exitCode: error.kind === "filesystem" ? 6 : 2,
});

export const renderMutation = (
  mutation: SkillMutation,
  json: boolean,
): Execution => ({
  stdout: json
    ? renderJson(mutation)
    : `${mutation.action} ${mutation.agent} skill (${mutation.scope}): ${mutation.path}\n`,
  stderr: "",
  exitCode: 0,
});

export const renderUpdateAll = (
  result: SkillUpdateAllResult,
  json: boolean,
): Execution => {
  if (json) return { stdout: renderJson(result), stderr: "", exitCode: 0 };
  const lines = [
    ...result.updated.map(
      ({ agent, scope, path }) => `updated ${agent} skill (${scope}): ${path}`,
    ),
    ...result.skipped.map(
      ({ agent, scope, path }) =>
        `skipped ${agent} skill (${scope}, not installed): ${path}`,
    ),
  ];
  return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
};

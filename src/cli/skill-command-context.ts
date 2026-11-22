import { SKILL_AGENTS } from "../skill/index.ts";
import { commandError } from "./errors.ts";
import type { Command } from "commander";

import { renderJson } from "../output/index.ts";
import type {
  SkillContext,
  SkillError,
  SkillMutation,
  SkillScope,
  SkillUpdateAllResult,
} from "../skill/index.ts";
import type { CommandResult } from "./contracts.ts";

export type SkillInvocation = Readonly<{
  context: SkillContext;
  json: boolean;
  colorsEnabled: boolean;
}>;

export type SkillCommandContext = Readonly<{
  skill: Command;
  beginCommand: () => SkillInvocation | undefined;
  complete: (execution: CommandResult) => void;
}>;

export const scopeFrom = (local?: boolean): SkillScope =>
  local ? "local" : "global";

const mutationLine = ({ action, agent, scope, path }: SkillMutation): string =>
  `${action} ${agent} skill (${scope}): ${path}\n`;

export const renderSkillError = (
  error: SkillError,
  json = false,
  additionalAgents: readonly string[] = [],
): CommandResult => {
  const code =
    error.kind === "unknown_agent"
      ? "invalid_usage"
      : error.kind === "filesystem"
        ? "internal_error"
        : "invalid_state";
  if (error.completed?.length) {
    return {
      stdout: json
        ? renderJson({
            completed: error.completed,
            failed: { code, message: error.message },
          })
        : error.completed.map(mutationLine).join(""),
      stderr: json ? "" : `error: ${error.message}\n`,
      exitCode: 1,
    };
  }
  return commandError(
    code,
    error.message,
    error.kind === "unknown_agent"
      ? {
          allowed_values: [
            ...SKILL_AGENTS.map(({ name }) => name),
            ...additionalAgents,
          ],
        }
      : {},
  );
};

export const renderMutation = (
  mutation: SkillMutation,
  json: boolean,
): CommandResult => ({
  stdout: json ? renderJson(mutation) : mutationLine(mutation),
  stderr: "",
  exitCode: 0,
});

export const renderUpdateAll = (
  result: SkillUpdateAllResult,
  json: boolean,
): CommandResult => {
  if (json) return { stdout: renderJson(result), stderr: "", exitCode: 0 };
  const lines = [
    ...result.updated.map(
      ({ agent, scope, path }) => `updated ${agent} skill (${scope}): ${path}`,
    ),
    ...result.skipped.map(
      ({ agent, scope, path, reason }) =>
        `skipped ${agent} skill (${scope}, ${reason === "not_installed" ? "not installed" : reason}): ${path}`,
    ),
  ];
  return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
};

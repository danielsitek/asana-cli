import type { Command } from "commander";

import { renderError } from "../output/index.ts";
import { commandPath } from "./capabilities.ts";
import type { CommandResult, Execution } from "./contracts.ts";

export const formatCommandResult = (
  result: CommandResult,
  json: boolean,
  command: Command,
): Execution => {
  if (!("error" in result)) return result;

  const { error, exitCode } = result;
  if (json) {
    const usage =
      error.code === "invalid_usage"
        ? {
            usage:
              error.usage ??
              `${commandPath(command)} ${command.usage()}`.trim(),
          }
        : {};
    const allowed = error.allowed_values?.slice(0, 20);
    return {
      stdout: "",
      stderr: renderError({
        ...error,
        ...usage,
        ...(allowed ? { allowed_values: allowed } : {}),
      }),
      exitCode,
    };
  }

  const help =
    error.code === "invalid_usage"
      ? `\n${command.helpInformation({ error: true })}`
      : "";
  const details = error.details?.message
    ? `Asana: ${error.details.message}\n`
    : "";
  const hint = (error.hints ?? []).map((text) => `hint: ${text}\n`).join("");
  return {
    stdout: "",
    stderr: `error: ${error.message}\n${details}${hint}${help}`,
    exitCode,
  };
};

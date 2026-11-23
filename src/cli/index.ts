import { Command, type OutputConfiguration } from "commander";

import { resolveToken } from "../auth/index.ts";
import type { Result } from "../shared/result.ts";
import { renderUpdateNotice } from "../update/index.ts";
import { registerAttachmentCommands } from "./attachment-commands.ts";
import { isLocalCommand } from "./capabilities.ts";
import { createCliParser } from "./cli-parser.ts";
import { formatCommandResult } from "./command-output.ts";
import { registerConfigCommands } from "./config-commands.ts";
import type {
  CommandRegistration,
  CommandResult,
  ExecuteDependencies,
  Execution,
} from "./contracts.ts";
import { registerProjectCommands } from "./project-commands.ts";
import { registerSkillCommands } from "./skill-commands.ts";
import { terminalColorsEnabled } from "./skill-list-output.ts";
import { registerTaskCommands } from "./task-commands.ts";
import {
  registerCapabilitiesCommand,
  registerCompletionCommand,
  registerWhoamiCommand,
  registerWorkspaceCommands,
} from "./core-commands.ts";
import { commandError, usageError } from "./errors.ts";

export type { ExecuteDependencies, Execution } from "./contracts.ts";

const requireToken = (
  dependencies: Pick<ExecuteDependencies, "environment">,
): Result<string, CommandResult> => {
  const token = resolveToken(dependencies.environment);
  return token.ok
    ? token
    : { ok: false, error: commandError("authentication", token.error.message) };
};

const appendUpdateNotice = async (
  execution: Execution,
  dependencies: ExecuteDependencies,
): Promise<Execution> => {
  if (execution.exitCode !== 0 || !dependencies.checkForUpdate) {
    return execution;
  }

  try {
    const notice = await dependencies.checkForUpdate();
    return notice
      ? { ...execution, stderr: execution.stderr + renderUpdateNotice(notice) }
      : execution;
  } catch {
    return execution;
  }
};

const registerCommands = (
  registration: CommandRegistration,
  dependencies: ExecuteDependencies,
  version: string,
  outputConfiguration: OutputConfiguration,
): void => {
  const { program, beginCommand, complete } = registration;
  const authenticatedRegistration = {
    ...registration,
    dependencies,
    requireToken: () => requireToken(dependencies),
    usageError,
  };
  registerWhoamiCommand(authenticatedRegistration, version);

  registerConfigCommands({
    ...authenticatedRegistration,
    beginCommand: () => {
      const { json } = beginCommand();
      const context = dependencies.configuration;
      if (!context) {
        complete(usageError("Configuration context is unavailable"));
        return undefined;
      }
      return { context, json };
    },
  });

  registerSkillCommands({
    ...registration,
    beginCommand: () => {
      const { json } = beginCommand();
      const context = dependencies.configuration;
      if (!context) {
        complete(
          commandError("internal_error", "Skill context is unavailable"),
        );
        return undefined;
      }
      return {
        context,
        json,
        colorsEnabled: terminalColorsEnabled(
          dependencies.stdoutIsTTY === true,
          dependencies.environment,
        ),
      };
    },
  });

  const fieldCommandRegistration = {
    ...authenticatedRegistration,
    outputConfiguration,
    beginCommand: () => {
      const { json } = beginCommand();
      const fields = program.opts<{ fields?: string }>().fields;
      return { json, ...(fields === undefined ? {} : { fields }) };
    },
  };
  registerTaskCommands(fieldCommandRegistration);
  registerAttachmentCommands({
    ...authenticatedRegistration,
    outputConfiguration,
  });
  registerProjectCommands(fieldCommandRegistration);

  registerWorkspaceCommands(authenticatedRegistration);
  registerCompletionCommand(registration);
  registerCapabilitiesCommand(registration, version);
};

export const execute = async (
  argv: readonly string[],
  dependencies: ExecuteDependencies,
): Promise<Execution> => {
  const version = dependencies.version ?? "0.13.0";
  const program = new Command()
    .name("asana-cli")
    .version(version, "-v, --version");
  const parser = createCliParser(program);
  let invoked = false;
  let result: CommandResult | undefined;

  registerCommands(
    {
      program,
      beginCommand: () => {
        invoked = true;
        return { json: parser.invocation.json };
      },
      complete: (execution) => {
        result = execution;
      },
    },
    dependencies,
    version,
    parser.outputConfiguration,
  );

  const parserExecution = await parser.parse(argv);
  if (parserExecution) return parserExecution;

  const { json, command } = parser.invocation;
  const execution =
    result ??
    usageError(invoked ? "Command did not complete" : "A command is required");
  const formatted = formatCommandResult(execution, json, command);
  if (
    json ||
    isLocalCommand(command) ||
    command.opts().dryRun === true ||
    program.opts().timeout !== undefined
  )
    return formatted;
  return appendUpdateNotice(formatted, dependencies);
};

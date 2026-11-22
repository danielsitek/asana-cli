import { Command, CommanderError } from "commander";

import { resolveToken } from "../auth/index.ts";
import {
  COMPLETION_SHELLS,
  isCompletionShell,
  renderCompletion,
} from "../completion/index.ts";
import type { ErrorAdvice } from "../shared/errors.ts";
import { ASANA_ERROR_CODES, asanaFailure, commandError } from "./errors.ts";
import {
  renderError,
  renderIdentity,
  renderJson,
  renderWorkspaceList,
} from "../output/index.ts";
import type { Result } from "../shared/result.ts";
import { renderUpdateNotice } from "../update/index.ts";
import { acceptsFieldsOptionAtPath } from "./field-selection.ts";
import { registerAttachmentCommands } from "./attachment-commands.ts";
import {
  capabilitiesForProgram,
  commandPath,
  isLocalCommand,
  withCommandCapabilities,
} from "./capabilities.ts";
import { registerConfigCommands } from "./config-commands.ts";
import type {
  CommandResult,
  ExecuteDependencies,
  Execution,
} from "./contracts.ts";
import { registerProjectCommands } from "./project-commands.ts";
import { registerSkillCommands } from "./skill-commands.ts";
import { terminalColorsEnabled } from "./skill-list-output.ts";
import { registerTaskCommands } from "./task-commands.ts";
import { executeWorkspacesList } from "../workspaces/index.ts";

export type { ExecuteDependencies, Execution } from "./contracts.ts";

const usageError = (message: string, advice?: ErrorAdvice): CommandResult =>
  commandError("invalid_usage", message, advice);

const requireToken = (
  dependencies: Pick<ExecuteDependencies, "environment">,
): Result<string, CommandResult> => {
  const token = resolveToken(dependencies.environment);
  return token.ok
    ? token
    : { ok: false, error: commandError("authentication", token.error.message) };
};

const formatCommandResult = (
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

function* helpPathArguments(argv: readonly string[]): Iterable<string> {
  const args = argv.values();
  for (const arg of args) {
    if (arg === "--") {
      yield* args;
      return;
    }
    if (arg === "--fields") {
      args.next();
      continue;
    }
    if (arg !== "--json" && !arg.startsWith("--fields=")) yield arg;
  }
}

const showHelpCommand = (program: Command, argv: readonly string[]): void => {
  let command = program;
  let helpRequested = false;

  for (const arg of helpPathArguments(argv)) {
    if (!helpRequested && arg === "help" && command.commands.length > 0) {
      helpRequested = true;
      continue;
    }
    if (helpRequested && ["--help", "-h"].includes(arg)) continue;

    const child = command.commands.find((candidate) =>
      [candidate.name(), ...candidate.aliases()].includes(arg),
    );
    if (!child) {
      if (!helpRequested) return;
      return command.error(`error: unknown command '${arg}'`, {
        code: "commander.unknownCommand",
      });
    }
    command = child;
  }

  if (helpRequested) command.help();
};

export const execute = async (
  argv: readonly string[],
  dependencies: ExecuteDependencies,
): Promise<Execution> => {
  const program = new Command()
    .name("asana-cli")
    .version(dependencies.version ?? "0.13.0", "-v, --version");
  const version = dependencies.version ?? "0.13.0";
  let json = false;
  const invokedState = { value: false };
  let result: CommandResult | undefined;
  let activeCommand = program;
  let failedParserCommand = program;
  let parserStdout = "";
  let parserStderr = "";

  const stopWith = (execution: CommandResult): void => {
    result = execution;
  };

  const captureOutput = {
    writeOut: (text: string) => {
      parserStdout += text;
    },
    writeErr: (text: string) => {
      parserStderr += text;
    },
  };

  program.option("--json", "output JSON");
  program.option("--fields <fields>", "select explicit Asana fields");

  program.hook("preAction", (thisCommand, actionCommand) => {
    activeCommand = actionCommand;
    json = program.opts<{ json?: boolean }>().json ?? false;
    if (thisCommand.opts<{ fields?: string }>().fields !== undefined) {
      const commandPath = [actionCommand.parent?.name(), actionCommand.name()]
        .filter((part): part is string => part !== undefined)
        .join("/");
      if (!acceptsFieldsOptionAtPath(commandPath)) {
        throw new CommanderError(
          2,
          "commander.fieldsNotSupported",
          "Option --fields is not supported for this command",
        );
      }
    }
  });

  const whoami = program
    .command("whoami")
    .description("show the authenticated Asana user")
    .action(async () => {
      invokedState.value = true;
      const token = requireToken(dependencies);
      if (!token.ok) {
        stopWith(token.error);
        return;
      }
      const identity = await dependencies.identity.getAuthenticatedUser(
        token.value,
      );
      if (!identity.ok) {
        result = asanaFailure(identity.error);
        return;
      }
      result = {
        stdout: json
          ? renderJson(identity.value)
          : renderIdentity(identity.value),
        stderr: "",
        exitCode: 0,
      };
    });
  withCommandCapabilities(whoami, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    errors: [...ASANA_ERROR_CODES],
  });
  whoami.version(version, "-v, --version");

  registerConfigCommands({
    program,
    dependencies,
    beginCommand: () => {
      invokedState.value = true;
      const context = dependencies.configuration;
      if (!context) {
        result = usageError("Configuration context is unavailable");
        return undefined;
      }
      return { context, json };
    },
    complete: stopWith,
    requireToken: () => requireToken(dependencies),
    usageError,
  });

  registerSkillCommands({
    program,
    beginCommand: () => {
      invokedState.value = true;
      const context = dependencies.configuration;
      if (!context) {
        result = commandError("internal_error", "Skill context is unavailable");
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
    complete: stopWith,
  });

  registerTaskCommands({
    program,
    dependencies,
    beginCommand: () => {
      invokedState.value = true;
      const fields = program.opts<{ fields?: string }>().fields;
      return { json, ...(fields === undefined ? {} : { fields }) };
    },
    complete: stopWith,
    requireToken: () => requireToken(dependencies),
    usageError,
    outputConfiguration: captureOutput,
  });

  registerAttachmentCommands({
    program,
    dependencies,
    beginCommand: () => {
      invokedState.value = true;
      return { json };
    },
    complete: stopWith,
    requireToken: () => requireToken(dependencies),
    usageError,
    outputConfiguration: captureOutput,
  });

  registerProjectCommands({
    program,
    dependencies,
    beginCommand: () => {
      invokedState.value = true;
      const fields = program.opts<{ fields?: string }>().fields;
      return { json, ...(fields === undefined ? {} : { fields }) };
    },
    complete: stopWith,
    requireToken: () => requireToken(dependencies),
    usageError,
    outputConfiguration: captureOutput,
  });

  const workspaces = program
    .command("workspaces")
    .description("inspect workspaces");
  withCommandCapabilities(workspaces, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
  });
  workspaces.exitOverride();
  workspaces.configureOutput(captureOutput);

  const workspacesList = workspaces
    .command("list")
    .description("list workspaces visible to the authenticated user")
    .action(async () => {
      invokedState.value = true;

      const tokenResult = requireToken(dependencies);
      if (!tokenResult.ok) {
        stopWith(tokenResult.error);
        return;
      }

      if (!dependencies.workspaceReader) {
        result = commandError("internal_error", "Workspace reader is required");
        return;
      }

      const listed = await executeWorkspacesList(tokenResult.value, {
        reader: dependencies.workspaceReader,
      });
      if (!listed.ok) {
        result = asanaFailure(listed.error);
        return;
      }

      result = {
        stdout: json
          ? renderJson(listed.value)
          : renderWorkspaceList(listed.value),
        stderr: "",
        exitCode: 0,
      };
    });
  withCommandCapabilities(workspacesList, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    errors: [...ASANA_ERROR_CODES],
  });

  workspacesList.exitOverride();
  workspacesList.configureOutput(captureOutput);

  const completion = program
    .command("completion")
    .argument("<shell>", "shell to generate completion for")
    .description("generate shell completion script")
    .action((shell: string) => {
      invokedState.value = true;
      if (!isCompletionShell(shell)) {
        result = usageError(
          `Unsupported shell: ${shell}; expected ${COMPLETION_SHELLS.join(", ")}`,
          { allowed_values: COMPLETION_SHELLS },
        );
        return;
      }
      result = {
        stdout: renderCompletion(program, shell),
        stderr: "",
        exitCode: 0,
      };
    });
  withCommandCapabilities(completion, {
    operation: "local",
    requirements: { authentication: "never", configuration: "never" },
    argumentChoices: { shell: COMPLETION_SHELLS },
  });
  completion.exitOverride();
  completion.configureOutput(captureOutput);

  const capabilities = program
    .command("capabilities")
    .argument("[path...]", "command or group path to inspect")
    .description("describe the CLI contract for automation")
    .action((path: string[]) => {
      invokedState.value = true;
      const usage = "asana-cli capabilities [path...] --json";
      if (!json) {
        result = usageError("capabilities requires --json", { usage });
        return;
      }
      const document = capabilitiesForProgram(
        program,
        version,
        path.flatMap((part) => part.trim().split(/\s+/)),
      );
      result = document
        ? { stdout: renderJson(document), stderr: "", exitCode: 0 }
        : usageError(
            `Unknown command path: ${JSON.stringify(path.join(" "))}`,
            {
              usage,
            },
          );
    });
  withCommandCapabilities(capabilities, {
    operation: "local",
    requirements: { authentication: "never", configuration: "never" },
    options: { json: { required: true } },
  });
  capabilities.exitOverride();
  capabilities.configureOutput(captureOutput);

  const configureParser = (command: Command): void => {
    command.exitOverride();
    command.configureOutput({
      ...captureOutput,
      outputError: (str, write) => {
        failedParserCommand = command;
        write(str);
      },
    });
    command.showHelpAfterError();
    command.showSuggestionAfterError();
    for (const child of command.commands) configureParser(child);
  };
  configureParser(program);

  try {
    // Commander's implicit help accepts only one command name.
    showHelpCommand(program, argv);
    const effectiveArgv = argv.length === 0 ? ["--help"] : argv;
    await program.parseAsync(["bun", "asana-cli", ...effectiveArgv], {
      from: "node",
    });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        return { stdout: parserStdout, stderr: "", exitCode: 0 };
      }
      if (error.code === "commander.help") {
        return {
          stdout: parserStdout || parserStderr,
          stderr: "",
          exitCode: 0,
        };
      }
      if (error.code === "commander.fieldsNotSupported") {
        return formatCommandResult(
          usageError(error.message),
          json,
          activeCommand,
        );
      }
      const separator = argv.indexOf("--");
      const jsonRequested = argv
        .slice(0, separator === -1 ? argv.length : separator)
        .includes("--json");
      if (!jsonRequested && parserStderr !== "") {
        return { stdout: "", stderr: parserStderr, exitCode: 2 };
      }
      return formatCommandResult(
        usageError(error.message.replace(/^error: /, "")),
        jsonRequested,
        failedParserCommand,
      );
    }
    return formatCommandResult(
      commandError("internal_error", "An unexpected internal error occurred"),
      json,
      activeCommand,
    );
  }
  const execution =
    result ??
    (invokedState.value
      ? usageError("Command did not complete")
      : usageError("A command is required"));
  const formatted = formatCommandResult(execution, json, activeCommand);
  if (json || isLocalCommand(activeCommand)) return formatted;
  return appendUpdateNotice(formatted, dependencies);
};

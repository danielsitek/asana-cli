import { Command, CommanderError } from "commander";

import { resolveToken } from "../auth/index.ts";
import { withNetworkDeadline } from "../shared/network-deadline.ts";
import { commandError, usageError } from "./errors.ts";
import { renderError } from "../output/index.ts";
import type { Result } from "../shared/result.ts";
import { renderUpdateNotice } from "../update/index.ts";
import { acceptsFieldsOptionAtPath } from "./field-selection.ts";
import { registerAttachmentCommands } from "./attachment-commands.ts";
import { commandPath, isLocalCommand } from "./capabilities.ts";
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
import {
  registerCapabilitiesCommand,
  registerCompletionCommand,
  registerWhoamiCommand,
  registerWorkspaceCommands,
} from "./core-commands.ts";

export type { ExecuteDependencies, Execution } from "./contracts.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

const timeoutMilliseconds = (seconds: string | undefined): number => {
  if (seconds === undefined) return DEFAULT_TIMEOUT_MS;
  const milliseconds = Math.ceil(Number(seconds) * 1000);
  if (
    !/^\d+(?:\.\d+)?$/.test(seconds) ||
    milliseconds < 1 ||
    milliseconds > MAX_TIMEOUT_MS
  ) {
    throw new CommanderError(
      2,
      "commander.invalidTimeout",
      "--timeout must be a positive number of seconds within the supported timer range",
    );
  }
  return milliseconds;
};

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
    if (arg === "--fields" || arg === "--timeout") {
      args.next();
      continue;
    }
    if (
      arg !== "--json" &&
      !arg.startsWith("--fields=") &&
      !arg.startsWith("--timeout=")
    )
      yield arg;
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
  const deadline = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
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
  program.option(
    "--timeout <seconds>",
    "total network deadline in seconds (default: 120)",
  );
  program.option("--fields <fields>", "select explicit Asana fields");

  program.hook("preAction", (thisCommand, actionCommand) => {
    activeCommand = actionCommand;
    const options = program.opts<{ json?: boolean; timeout?: string }>();
    json = options.json ?? false;
    deadlineTimer = setTimeout(
      () => deadline.abort(),
      timeoutMilliseconds(options.timeout),
    );
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

  const beginCommand = () => {
    invokedState.value = true;
    return { json };
  };
  const coreRegistration = { program, beginCommand, complete: stopWith };
  const authenticatedRegistration = {
    ...coreRegistration,
    requireToken: () => requireToken(dependencies),
  };
  registerWhoamiCommand(authenticatedRegistration, dependencies, version);

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

  const fieldCommandRegistration = {
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
  };
  registerTaskCommands(fieldCommandRegistration);

  registerAttachmentCommands({
    program,
    dependencies,
    beginCommand,
    complete: stopWith,
    requireToken: () => requireToken(dependencies),
    usageError,
    outputConfiguration: captureOutput,
  });

  registerProjectCommands(fieldCommandRegistration);

  registerWorkspaceCommands(authenticatedRegistration, dependencies);
  registerCompletionCommand(coreRegistration);
  registerCapabilitiesCommand(coreRegistration, version);

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
    await withNetworkDeadline(deadline.signal, () =>
      program.parseAsync(["bun", "asana-cli", ...effectiveArgv], {
        from: "node",
      }),
    );
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
      if (
        error.code === "commander.fieldsNotSupported" ||
        error.code === "commander.invalidTimeout"
      ) {
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
  } finally {
    clearTimeout(deadlineTimer);
  }
  const execution =
    result ??
    (invokedState.value
      ? usageError("Command did not complete")
      : usageError("A command is required"));
  const formatted = formatCommandResult(execution, json, activeCommand);
  if (
    json ||
    isLocalCommand(activeCommand) ||
    activeCommand.opts().dryRun === true ||
    program.opts().timeout !== undefined
  )
    return formatted;
  return appendUpdateNotice(formatted, dependencies);
};

import {
  CommanderError,
  type Command,
  type OutputConfiguration,
} from "commander";

import { withNetworkDeadline } from "../shared/network-deadline.ts";
import { formatCommandResult } from "./command-output.ts";
import type { Execution } from "./contracts.ts";
import { commandError, usageError } from "./errors.ts";
import { acceptsFieldsOptionAtPath } from "./field-selection.ts";

type Invocation = { command: Command; json: boolean };
type ParserOutput = { stdout: string; stderr: string; failedCommand: Command };

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

const validateFieldsOption = (
  program: Command,
  actionCommand: Command,
): void => {
  if (program.opts<{ fields?: string }>().fields === undefined) return;

  const path = [actionCommand.parent?.name(), actionCommand.name()]
    .filter((part): part is string => part !== undefined)
    .join("/");
  if (!acceptsFieldsOptionAtPath(path)) {
    throw new CommanderError(
      2,
      "commander.fieldsNotSupported",
      "Option --fields is not supported for this command",
    );
  }
};

const configureParser = (
  command: Command,
  outputConfiguration: OutputConfiguration,
  output: ParserOutput,
): void => {
  command.exitOverride();
  command.configureOutput({
    ...outputConfiguration,
    outputError: (str, write) => {
      output.failedCommand = command;
      write(str);
    },
  });
  command.showHelpAfterError();
  command.showSuggestionAfterError();
  for (const child of command.commands) {
    configureParser(child, outputConfiguration, output);
  }
};

const formatParserError = (
  error: CommanderError,
  argv: readonly string[],
  output: ParserOutput,
  invocation: Invocation,
): Execution => {
  switch (error.code) {
    case "commander.helpDisplayed":
    case "commander.version":
      return { stdout: output.stdout, stderr: "", exitCode: 0 };
    case "commander.help":
      return {
        stdout: output.stdout || output.stderr,
        stderr: "",
        exitCode: 0,
      };
    case "commander.fieldsNotSupported":
    case "commander.invalidTimeout":
      return formatCommandResult(
        usageError(error.message),
        invocation.json,
        invocation.command,
      );
  }

  const separator = argv.indexOf("--");
  const jsonRequested = argv
    .slice(0, separator === -1 ? argv.length : separator)
    .includes("--json");
  if (!jsonRequested && output.stderr !== "") {
    return { stdout: "", stderr: output.stderr, exitCode: 2 };
  }
  return formatCommandResult(
    usageError(error.message.replace(/^error: /, "")),
    jsonRequested,
    output.failedCommand,
  );
};

export const createCliParser = (program: Command) => {
  const invocation: Invocation = { command: program, json: false };
  const output: ParserOutput = {
    stdout: "",
    stderr: "",
    failedCommand: program,
  };
  const outputConfiguration = {
    writeOut: (text: string) => {
      output.stdout += text;
    },
    writeErr: (text: string) => {
      output.stderr += text;
    },
  };

  const deadline = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  program.option("--json", "output JSON");
  program.option(
    "--timeout <seconds>",
    "total network deadline in seconds (default: 120)",
  );
  program.option("--fields <fields>", "select explicit Asana fields");
  program.hook("preAction", (thisCommand, actionCommand) => {
    invocation.command = actionCommand;
    const options = program.opts<{ json?: boolean; timeout?: string }>();
    invocation.json = options.json ?? false;
    deadlineTimer = setTimeout(
      () => deadline.abort(),
      timeoutMilliseconds(options.timeout),
    );
    validateFieldsOption(thisCommand, actionCommand);
  });

  const parse = async (
    argv: readonly string[],
  ): Promise<Execution | undefined> => {
    configureParser(program, outputConfiguration, output);
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
        return formatParserError(error, argv, output, invocation);
      }
      return formatCommandResult(
        commandError("internal_error", "An unexpected internal error occurred"),
        invocation.json,
        invocation.command,
      );
    } finally {
      clearTimeout(deadlineTimer);
    }
  };

  return { invocation, outputConfiguration, parse };
};

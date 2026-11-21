import { Command, CommanderError } from "commander";

import { resolveToken } from "../auth/index.ts";
import {
  COMPLETION_SHELLS,
  isCompletionShell,
  renderCompletion,
} from "../completion/index.ts";
import type { IdentityError as AsanaError } from "../identity/index.ts";
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

const usageError = (message: string): CommandResult => ({
  error: { code: "invalid_usage", message },
  exitCode: 2,
});

const requireToken = (
  dependencies: Pick<ExecuteDependencies, "environment">,
): Result<string, CommandResult> => {
  const token = resolveToken(dependencies.environment);
  return token.ok
    ? token
    : {
        ok: false,
        error: {
          error: {
            code: "authentication",
            message: token.error.message,
          },
          exitCode: 3,
        },
      };
};

const identityFailures: Readonly<
  Record<AsanaError["kind"], Readonly<{ exitCode: number; message: string }>>
> = {
  authentication: { exitCode: 3, message: "Asana authentication failed" },
  api: { exitCode: 4, message: "Asana API request failed" },
  rate_limit: { exitCode: 5, message: "Asana request retries exhausted" },
  network: { exitCode: 4, message: "Unable to reach Asana" },
  invalid_response: {
    exitCode: 4,
    message: "Asana returned an invalid response",
  },
};

const renderIdentityFailure = (kind: AsanaError["kind"]): CommandResult => {
  const mapped = identityFailures[kind];
  return {
    error: { code: kind, message: mapped.message },
    exitCode: mapped.exitCode,
  };
};

const formatCommandResult = (
  result: CommandResult,
  json: boolean,
  command: Command,
): Execution => {
  if (!("error" in result)) return result;

  const { error, exitCode } = result;
  if (json) return { stdout: "", stderr: renderError(error), exitCode };

  const help =
    error.code === "invalid_usage"
      ? `\n${command.helpInformation({ error: true })}`
      : "";
  const hint = error.hint === undefined ? "" : `hint: ${error.hint}\n`;
  return {
    stdout: "",
    stderr: `error: ${error.message}\n${hint}${help}`,
    exitCode,
  };
};

const appendUpdateNotice = async (
  execution: Execution,
  dependencies: ExecuteDependencies,
  skipUpdateCheck: boolean,
): Promise<Execution> => {
  if (
    execution.exitCode !== 0 ||
    skipUpdateCheck ||
    !dependencies.checkForUpdate
  ) {
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
  let parserStdout = "";
  let parserStderr = "";
  let skipUpdateCheck = false;

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
        result = renderIdentityFailure(identity.error.kind);
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
    exitCodes: [0, 2, 3, 4, 5, 6],
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
    renderIdentityFailure,
    usageError,
  });

  registerSkillCommands({
    program,
    beginCommand: () => {
      invokedState.value = true;
      const context = dependencies.configuration;
      if (!context) {
        result = {
          error: {
            code: "internal_error",
            message: "Skill context is unavailable",
          },
          exitCode: 6,
        };
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
    renderIdentityFailure,
    usageError,
    outputConfiguration: captureOutput,
  });

  const workspaces = program
    .command("workspaces")
    .description("inspect workspaces");
  withCommandCapabilities(workspaces, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    exitCodes: [0, 2, 3, 4, 5, 6],
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
        result = {
          error: {
            code: "internal_error",
            message: "Workspace reader is required",
          },
          exitCode: 6,
        };
        return;
      }

      const listed = await executeWorkspacesList(tokenResult.value, {
        reader: dependencies.workspaceReader,
      });
      if (!listed.ok) {
        result = renderIdentityFailure(listed.error.kind);
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
    exitCodes: [0, 2, 3, 4, 5, 6],
  });

  workspacesList.exitOverride();
  workspacesList.configureOutput(captureOutput);

  const completion = program
    .command("completion <shell>")
    .description("generate shell completion script")
    .action((shell: string) => {
      invokedState.value = true;
      if (!isCompletionShell(shell)) {
        result = usageError(
          `Unsupported shell: ${shell}; expected ${COMPLETION_SHELLS.join(", ")}`,
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
    exitCodes: [0, 2],
  });
  completion.exitOverride();
  completion.configureOutput(captureOutput);

  const capabilities = program
    .command("capabilities")
    .description("describe the CLI contract for automation")
    .action(() => {
      invokedState.value = true;
      skipUpdateCheck = true;
      result = json
        ? {
            stdout: renderJson(capabilitiesForProgram(program, version)),
            stderr: "",
            exitCode: 0,
          }
        : usageError("capabilities requires --json");
    });
  withCommandCapabilities(capabilities, {
    operation: "local",
    requirements: { authentication: "never", configuration: "never" },
    exitCodes: [0, 2],
    options: { json: { required: true } },
  });
  capabilities.exitOverride();
  capabilities.configureOutput(captureOutput);

  const configureParser = (command: Command): void => {
    command.exitOverride();
    command.configureOutput(captureOutput);
    command.showHelpAfterError();
    command.showSuggestionAfterError();
    for (const child of command.commands) configureParser(child);
  };
  configureParser(program);

  try {
    // Commander's implicit help accepts only one command name.
    showHelpCommand(program, argv);
    const effectiveArgv =
      argv.length === 0
        ? ["--help"]
        : argv.length === 2 && argv[0] === "tasks" && argv[1] === "list"
          ? [...argv, "--help"]
          : argv;
    await program.parseAsync(["bun", "asana-cli", ...effectiveArgv], {
      from: "node",
    });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        return appendUpdateNotice(
          { stdout: parserStdout, stderr: "", exitCode: 0 },
          dependencies,
          skipUpdateCheck,
        );
      }
      if (error.code === "commander.help") {
        return appendUpdateNotice(
          { stdout: parserStdout || parserStderr, stderr: "", exitCode: 0 },
          dependencies,
          skipUpdateCheck,
        );
      }
      if (error.code === "commander.fieldsNotSupported") {
        return formatCommandResult(
          usageError(error.message),
          json,
          activeCommand,
        );
      }
      const jsonRequested = argv.includes("--json");
      if (!jsonRequested && parserStderr !== "") {
        return { stdout: "", stderr: parserStderr, exitCode: 2 };
      }
      return formatCommandResult(
        usageError(error.message.replace(/^error: /, "")),
        jsonRequested,
        activeCommand,
      );
    }
    return formatCommandResult(
      {
        error: {
          code: "internal_error",
          message: "An unexpected internal error occurred",
        },
        exitCode: 6,
      },
      json,
      activeCommand,
    );
  }
  const execution =
    result ??
    (invokedState.value
      ? usageError("Command did not complete")
      : usageError("A command is required"));
  return appendUpdateNotice(
    formatCommandResult(execution, json, activeCommand),
    dependencies,
    skipUpdateCheck,
  );
};

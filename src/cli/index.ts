import { Command, CommanderError, Option } from "commander";

import { resolveToken } from "../auth/index.ts";
import {
  COMPLETION_SHELLS,
  isCompletionShell,
  renderCompletion,
} from "../completion/index.ts";
import { resolveConfig } from "../config/index.ts";
import type { IdentityError as AsanaError } from "../identity/index.ts";
import { validateFieldList } from "../tasks/index.ts";
import {
  renderError,
  renderIdentity,
  renderJson,
  renderProjectList,
  renderProjectDetail,
  renderProjectListScanWarning,
  renderProjectSectionList,
  renderProjectSectionListScanWarning,
  renderProjectCustomFieldSettingList,
  renderProjectCustomFieldSettingListScanWarning,
  renderWorkspaceList,
} from "../output/index.ts";
import {
  executeProjectList,
  executeProjectSectionList,
  executeProjectCustomFieldSettingList,
  DEFAULT_PROJECT_FIELDS,
  DEFAULT_PROJECT_SECTION_FIELDS,
  DEFAULT_PROJECT_CUSTOM_FIELD_SETTING_FIELDS,
  parseProjectGid,
  prepareProjectList,
  prepareProjectSectionList,
  prepareProjectCustomFieldSettingList,
  type ProjectReadError,
} from "../projects/index.ts";
import type { Result } from "../shared/result.ts";
import { renderUpdateNotice } from "../update/index.ts";
import { acceptsFieldsOptionAtPath } from "./field-selection.ts";
import {
  capabilitiesForProgram,
  withCommandCapabilities,
} from "./capabilities.ts";
import { registerConfigCommands } from "./config-commands.ts";
import { renderConfigFailure } from "./config-error.ts";
import type { ExecuteDependencies, Execution } from "./contracts.ts";
import { registerTaskCommands } from "./task-commands.ts";
import { executeWorkspacesList } from "../workspaces/index.ts";

export type { ExecuteDependencies, Execution } from "./contracts.ts";

const usageError = (message: string): Execution => ({
  stdout: "",
  stderr: renderError({ code: "invalid_usage", message }),
  exitCode: 2,
});

const PROJECT_ID_ARGUMENT = "<id>";

const requireToken = (
  dependencies: Pick<ExecuteDependencies, "environment">,
): Result<string, Execution> => {
  const token = resolveToken(dependencies.environment);
  return token.ok
    ? token
    : {
        ok: false,
        error: {
          stdout: "",
          stderr: renderError({
            code: "authentication",
            message: token.error.message,
          }),
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

const renderIdentityFailure = (kind: AsanaError["kind"]): Execution => {
  const mapped = identityFailures[kind];
  return {
    stdout: "",
    stderr: renderError({ code: kind, message: mapped.message }),
    exitCode: mapped.exitCode,
  };
};

const projectReadFailures: Readonly<
  Record<
    ProjectReadError["kind"],
    Readonly<{ exitCode: number; message: string }>
  >
> = {
  authentication: { exitCode: 3, message: "Asana authentication failed" },
  api: { exitCode: 4, message: "Asana API request failed" },
  not_found: { exitCode: 4, message: "Project not found" },
  rate_limit: { exitCode: 5, message: "Asana request retries exhausted" },
  network: { exitCode: 4, message: "Unable to reach Asana" },
  invalid_response: {
    exitCode: 4,
    message: "Asana returned an invalid response",
  },
};

const renderProjectReadFailure = (
  kind: ProjectReadError["kind"],
): Execution => {
  const mapped = projectReadFailures[kind];
  return {
    stdout: "",
    stderr: renderError({ code: kind, message: mapped.message }),
    exitCode: mapped.exitCode,
  };
};

export const execute = async (
  argv: readonly string[],
  dependencies: ExecuteDependencies,
): Promise<Execution> => {
  const program = new Command()
    .name("asana-cli")
    .version(dependencies.version ?? "0.6.1", "-v, --version");
  const version = dependencies.version ?? "0.6.1";
  let json = false;
  const invokedState = { value: false };
  let result: Execution | undefined;
  let parserStdout = "";
  let skipUpdateCheck = false;

  const stopWith = (execution: Execution): void => {
    result = execution;
  };

  const captureOutput = {
    writeOut: (text: string) => {
      parserStdout += text;
    },
    writeErr: () => undefined,
  };

  program.option("--json", "output JSON");
  program.option("--fields <fields>", "select explicit Asana fields");

  program.hook("preAction", (thisCommand, actionCommand) => {
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
      json = program.opts<{ json?: boolean }>().json ?? false;
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
      json = program.opts<{ json?: boolean }>().json ?? false;
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

  registerTaskCommands({
    program,
    dependencies,
    beginCommand: () => {
      invokedState.value = true;
      json = program.opts<{ json?: boolean }>().json ?? false;
      const fields = program.opts<{ fields?: string }>().fields;
      return { json, ...(fields === undefined ? {} : { fields }) };
    },
    complete: stopWith,
    requireToken: () => requireToken(dependencies),
    usageError,
    outputConfiguration: captureOutput,
  });

  const projects = program.command("projects").description("inspect projects");
  withCommandCapabilities(projects, {
    operation: "read",
    requirements: {
      authentication: "required",
      configuration: "conditional",
    },
    exitCodes: [0, 2, 3, 4, 5, 6],
  });
  projects.exitOverride();
  projects.configureOutput(captureOutput);

  const projectsGet = projects
    .command("get")
    .argument(PROJECT_ID_ARGUMENT, "project GID")
    .description("read a project's details")
    .action(async (idArg: string) => {
      invokedState.value = true;
      json = program.opts<{ json?: boolean }>().json ?? false;

      const parsedId = parseProjectGid(idArg);
      if (!parsedId.ok) {
        result = usageError(parsedId.error.message);
        return;
      }

      const fieldsInput = program.opts<{ fields?: string }>().fields;
      const validatedFields =
        fieldsInput === undefined
          ? { ok: true as const, value: DEFAULT_PROJECT_FIELDS }
          : validateFieldList(fieldsInput);
      if (!validatedFields.ok) {
        result = usageError(validatedFields.error);
        return;
      }

      const token = requireToken(dependencies);
      if (!token.ok) {
        stopWith(token.error);
        return;
      }
      if (!dependencies.projectDetailReader) {
        result = {
          stdout: "",
          stderr: renderError({
            code: "internal_error",
            message: "Project reader is required",
          }),
          exitCode: 6,
        };
        return;
      }

      const project = await dependencies.projectDetailReader.getProject({
        token: token.value,
        projectGid: parsedId.value,
        fields: validatedFields.value,
      });
      if (!project.ok) {
        result = renderProjectReadFailure(project.error.kind);
        return;
      }
      result = {
        stdout: json
          ? renderJson(project.value)
          : renderProjectDetail(project.value),
        stderr: "",
        exitCode: 0,
      };
    });
  withCommandCapabilities(projectsGet, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    exitCodes: [0, 2, 3, 4, 5, 6],
  });

  projectsGet.exitOverride();
  projectsGet.configureOutput(captureOutput);

  const projectsSections = projects
    .command("sections")
    .argument(PROJECT_ID_ARGUMENT, "project GID")
    .description("list a project's sections")
    .addOption(new Option("--max <n>", "cap sections scanned"))
    .option("--all", "return all sections within the scan cap")
    .action(
      async (
        idArg: string,
        options: Readonly<{ max?: string; all?: boolean }>,
      ) => {
        invokedState.value = true;
        json = program.opts<{ json?: boolean }>().json ?? false;

        const fieldsInput = program.opts<{ fields?: string }>().fields;
        const validatedFields =
          fieldsInput === undefined
            ? { ok: true as const, value: DEFAULT_PROJECT_SECTION_FIELDS }
            : validateFieldList(fieldsInput);
        if (!validatedFields.ok) {
          result = usageError(validatedFields.error);
          return;
        }
        const prepared = prepareProjectSectionList({
          projectGid: idArg,
          ...options,
          fields: validatedFields.value,
        });
        if (!prepared.ok) {
          result = usageError(prepared.error.message);
          return;
        }

        const token = requireToken(dependencies);
        if (!token.ok) {
          stopWith(token.error);
          return;
        }
        if (!dependencies.projectSectionReader) {
          result = {
            stdout: "",
            stderr: renderError({
              code: "internal_error",
              message: "Project section reader is required",
            }),
            exitCode: 6,
          };
          return;
        }

        const listed = await executeProjectSectionList(
          token.value,
          prepared.value,
          { reader: dependencies.projectSectionReader },
        );
        if (!listed.ok) {
          result = renderProjectReadFailure(listed.error.kind);
          return;
        }
        result = {
          stdout: json
            ? renderJson(listed.value.sections, listed.value.meta)
            : renderProjectSectionList(
                listed.value.sections,
                prepared.value.fields,
              ),
          stderr: json
            ? ""
            : renderProjectSectionListScanWarning(
                listed.value.meta.scan_truncated,
              ),
          exitCode: 0,
        };
      },
    );
  withCommandCapabilities(projectsSections, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    exitCodes: [0, 2, 3, 4, 5, 6],
  });

  projectsSections.exitOverride();
  projectsSections.configureOutput(captureOutput);

  const projectsCustomFields = projects
    .command("custom-fields")
    .argument(PROJECT_ID_ARGUMENT, "project GID")
    .description("list a project's custom-field settings")
    .addOption(new Option("--max <n>", "cap custom-field settings scanned"))
    .option("--all", "return all custom-field settings within the scan cap")
    .addHelpText(
      "after",
      "\nGlobal options:\n  --json             output JSON\n  --fields <fields>  select explicit Asana fields",
    )
    .action(
      async (
        idArg: string,
        options: Readonly<{ max?: string; all?: boolean }>,
      ) => {
        invokedState.value = true;
        json = program.opts<{ json?: boolean }>().json ?? false;
        const fieldsInput = program.opts<{ fields?: string }>().fields;
        const validatedFields =
          fieldsInput === undefined
            ? {
                ok: true as const,
                value: DEFAULT_PROJECT_CUSTOM_FIELD_SETTING_FIELDS,
              }
            : validateFieldList(fieldsInput);
        if (!validatedFields.ok) {
          result = usageError(validatedFields.error);
          return;
        }
        const prepared = prepareProjectCustomFieldSettingList({
          projectGid: idArg,
          ...options,
          fields: validatedFields.value,
        });
        if (!prepared.ok) {
          result = usageError(prepared.error.message);
          return;
        }
        const token = requireToken(dependencies);
        if (!token.ok) {
          stopWith(token.error);
          return;
        }
        if (!dependencies.projectCustomFieldSettingReader) {
          result = {
            stdout: "",
            stderr: renderError({
              code: "internal_error",
              message: "Project custom-field setting reader is required",
            }),
            exitCode: 6,
          };
          return;
        }
        const listed = await executeProjectCustomFieldSettingList(
          token.value,
          prepared.value,
          { reader: dependencies.projectCustomFieldSettingReader },
        );
        if (!listed.ok) {
          result = renderProjectReadFailure(listed.error.kind);
          return;
        }
        result = {
          stdout: json
            ? renderJson(listed.value.settings, listed.value.meta)
            : renderProjectCustomFieldSettingList(
                listed.value.settings,
                prepared.value.fields,
              ),
          stderr: json
            ? ""
            : renderProjectCustomFieldSettingListScanWarning(
                listed.value.meta.scan_truncated,
              ),
          exitCode: 0,
        };
      },
    );
  withCommandCapabilities(projectsCustomFields, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    exitCodes: [0, 2, 3, 4, 5, 6],
  });

  projectsCustomFields.exitOverride();
  projectsCustomFields.configureOutput(captureOutput);

  const projectsList = projects.command("list");
  projectsList.description("list projects visible in a workspace");
  projectsList.addOption(new Option("--workspace <gid>", "workspace GID"));
  projectsList.addOption(new Option("--max <n>", "cap projects scanned"));
  projectsList.option("--all", "return all projects within the scan cap");
  projectsList.action(
    async (
      options: Readonly<{
        workspace?: string;
        max?: string;
        all?: boolean;
      }>,
    ) => {
      invokedState.value = true;
      json = program.opts<{ json?: boolean }>().json ?? false;

      let configuredWorkspaceGid: string | undefined;
      if (options.workspace === undefined) {
        if (!dependencies.configuration) {
          result = {
            stdout: "",
            stderr: renderError({
              code: "internal_error",
              message: "Configuration is required",
            }),
            exitCode: 6,
          };
          return;
        }
        const resolved = await resolveConfig(dependencies.configuration);
        if (!resolved.ok) {
          result = renderConfigFailure(resolved.error);
          return;
        }
        configuredWorkspaceGid = resolved.value.value.workspace?.gid;
      }

      const prepared = prepareProjectList(options, configuredWorkspaceGid);
      if (!prepared.ok) {
        stopWith(usageError(prepared.error.message));
        return;
      }

      const tokenResult = requireToken(dependencies);
      if (!tokenResult.ok) {
        stopWith(tokenResult.error);
        return;
      }

      if (!dependencies.projectReader) {
        result = {
          stdout: "",
          stderr: renderError({
            code: "internal_error",
            message: "Project reader is required",
          }),
          exitCode: 6,
        };
        return;
      }

      const listed = await executeProjectList(
        tokenResult.value,
        prepared.value,
        { reader: dependencies.projectReader },
      );
      if (!listed.ok) {
        result = renderIdentityFailure(listed.error.kind);
        return;
      }

      result = {
        stdout: json
          ? renderJson(listed.value.projects, listed.value.meta)
          : renderProjectList(listed.value.projects),
        stderr: json
          ? ""
          : renderProjectListScanWarning(listed.value.meta.scan_truncated),
        exitCode: 0,
      };
    },
  );
  withCommandCapabilities(projectsList, {
    operation: "read",
    requirements: {
      authentication: "required",
      configuration: "conditional",
    },
    exitCodes: [0, 2, 3, 4, 5, 6],
  });

  projectsList.exitOverride();
  projectsList.configureOutput(captureOutput);

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
      json = program.opts<{ json?: boolean }>().json ?? false;

      const tokenResult = requireToken(dependencies);
      if (!tokenResult.ok) {
        stopWith(tokenResult.error);
        return;
      }

      if (!dependencies.workspaceReader) {
        result = {
          stdout: "",
          stderr: renderError({
            code: "internal_error",
            message: "Workspace reader is required",
          }),
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
      json = program.opts<{ json?: boolean }>().json ?? false;
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

  program.exitOverride();
  program.configureOutput(captureOutput);
  whoami.exitOverride();
  whoami.configureOutput(captureOutput);
  try {
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
      if (error.code === "commander.fieldsNotSupported") {
        return usageError(error.message);
      }
      return usageError("Invalid command usage");
    }
    return {
      stdout: "",
      stderr: renderError({
        code: "internal_error",
        message: "An unexpected internal error occurred",
      }),
      exitCode: 6,
    };
  }
  const execution =
    result ??
    (invokedState.value
      ? usageError("Command did not complete")
      : usageError("A command is required"));
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

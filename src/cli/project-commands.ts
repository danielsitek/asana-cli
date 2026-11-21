import { ASANA_ERROR_CODES, asanaFailure, commandError } from "./errors.ts";
import { Option, type Command, type OutputConfiguration } from "commander";

import { resolveConfig } from "../config/index.ts";
import {
  renderJson,
  renderProjectCustomFieldSettingList,
  renderProjectDetail,
  renderProjectList,
  renderProjectSectionList,
} from "../output/index.ts";
import type { ListOptions } from "../pagination/index.ts";
import {
  DEFAULT_PROJECT_CUSTOM_FIELD_SETTING_FIELDS,
  DEFAULT_PROJECT_FIELDS,
  DEFAULT_PROJECT_SECTION_FIELDS,
  executeProjectCustomFieldSettingList,
  executeProjectList,
  executeProjectSectionList,
  parseProjectGid,
  prepareProjectCustomFieldSettingList,
  prepareProjectList,
  prepareProjectSectionList,
  type ProjectListOptions,
} from "../projects/index.ts";
import type { Result } from "../shared/result.ts";
import { validateFieldList } from "../tasks/index.ts";
import { renderListContinuation } from "./list-pagination.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import { renderConfigFailure } from "./config-error.ts";
import type { ExecuteDependencies, CommandResult } from "./contracts.ts";

type ProjectCommandDependencies = Pick<
  ExecuteDependencies,
  | "configuration"
  | "projectReader"
  | "projectDetailReader"
  | "projectSectionReader"
  | "projectCustomFieldSettingReader"
>;

type ProjectInvocation = Readonly<{
  json: boolean;
  fields?: string;
}>;

type ProjectCommandRegistration = Readonly<{
  program: Command;
  dependencies: ProjectCommandDependencies;
  beginCommand: () => ProjectInvocation;
  complete: (execution: CommandResult) => void;
  requireToken: () => Result<string, CommandResult>;
  usageError: (message: string) => CommandResult;
  outputConfiguration: OutputConfiguration;
}>;

const PROJECT_ID_ARGUMENT = "<id>";

const internalError = (message: string): CommandResult =>
  commandError("internal_error", message);

const selectedFields = (
  fields: string | undefined,
  defaults: readonly string[],
  usageError: (message: string) => CommandResult,
): Result<readonly string[], CommandResult> => {
  if (fields === undefined) return { ok: true, value: defaults };
  const validated = validateFieldList(fields);
  return validated.ok
    ? validated
    : { ok: false, error: usageError(validated.error) };
};

const runProjectGet = async (
  idArg: string,
  registration: ProjectCommandRegistration,
): Promise<CommandResult> => {
  const invocation = registration.beginCommand();
  const parsedId = parseProjectGid(idArg);
  if (!parsedId.ok) return registration.usageError(parsedId.error.message);
  const fields = selectedFields(
    invocation.fields,
    DEFAULT_PROJECT_FIELDS,
    registration.usageError,
  );
  if (!fields.ok) return fields.error;
  const token = registration.requireToken();
  if (!token.ok) return token.error;
  const reader = registration.dependencies.projectDetailReader;
  if (!reader) return internalError("Project reader is required");
  const project = await reader.getProject({
    token: token.value,
    projectGid: parsedId.value,
    fields: fields.value,
  });
  if (!project.ok) return asanaFailure(project.error, "Project not found");
  return {
    stdout: invocation.json
      ? renderJson(project.value)
      : renderProjectDetail(project.value),
    stderr: "",
    exitCode: 0,
  };
};

const runProjectSections = async (
  idArg: string,
  options: ListOptions,
  registration: ProjectCommandRegistration,
): Promise<CommandResult> => {
  const invocation = registration.beginCommand();
  const fields = selectedFields(
    invocation.fields,
    DEFAULT_PROJECT_SECTION_FIELDS,
    registration.usageError,
  );
  if (!fields.ok) return fields.error;
  const prepared = prepareProjectSectionList({
    projectGid: idArg,
    ...options,
    fields: fields.value,
  });
  if (!prepared.ok) return registration.usageError(prepared.error.message);
  const token = registration.requireToken();
  if (!token.ok) return token.error;
  const reader = registration.dependencies.projectSectionReader;
  if (!reader) return internalError("Project section reader is required");
  const listed = await executeProjectSectionList(token.value, prepared.value, {
    reader,
  });
  if (!listed.ok) return asanaFailure(listed.error, "Project not found");
  return {
    stdout: invocation.json
      ? renderJson(listed.value.sections, listed.value.meta)
      : renderProjectSectionList(listed.value.sections, prepared.value.fields),
    stderr: invocation.json
      ? ""
      : renderListContinuation(
          listed.value.meta,
          ["projects", "sections", idArg],
          options,
          invocation.fields,
        ),
    exitCode: 0,
  };
};

const runProjectCustomFields = async (
  idArg: string,
  options: ListOptions,
  registration: ProjectCommandRegistration,
): Promise<CommandResult> => {
  const invocation = registration.beginCommand();
  const fields = selectedFields(
    invocation.fields,
    DEFAULT_PROJECT_CUSTOM_FIELD_SETTING_FIELDS,
    registration.usageError,
  );
  if (!fields.ok) return fields.error;
  const prepared = prepareProjectCustomFieldSettingList({
    projectGid: idArg,
    ...options,
    fields: fields.value,
  });
  if (!prepared.ok) return registration.usageError(prepared.error.message);
  const token = registration.requireToken();
  if (!token.ok) return token.error;
  const reader = registration.dependencies.projectCustomFieldSettingReader;
  if (!reader) {
    return internalError("Project custom-field setting reader is required");
  }
  const listed = await executeProjectCustomFieldSettingList(
    token.value,
    prepared.value,
    { reader },
  );
  if (!listed.ok) return asanaFailure(listed.error, "Project not found");
  return {
    stdout: invocation.json
      ? renderJson(listed.value.settings, listed.value.meta)
      : renderProjectCustomFieldSettingList(
          listed.value.settings,
          prepared.value.fields,
        ),
    stderr: invocation.json
      ? ""
      : renderListContinuation(
          listed.value.meta,
          ["projects", "custom-fields", idArg],
          options,
          invocation.fields,
        ),
    exitCode: 0,
  };
};

const configuredWorkspace = async (
  options: ProjectListOptions,
  registration: ProjectCommandRegistration,
): Promise<Result<string | undefined, CommandResult>> => {
  if (options.workspace !== undefined) {
    return { ok: true, value: undefined };
  }
  const configuration = registration.dependencies.configuration;
  if (!configuration) {
    return { ok: false, error: internalError("Configuration is required") };
  }
  const resolved = await resolveConfig(configuration);
  return resolved.ok
    ? { ok: true, value: resolved.value.value.workspace?.gid }
    : { ok: false, error: renderConfigFailure(resolved.error) };
};

const runProjectList = async (
  options: ProjectListOptions,
  registration: ProjectCommandRegistration,
): Promise<CommandResult> => {
  const invocation = registration.beginCommand();
  const workspace = await configuredWorkspace(options, registration);
  if (!workspace.ok) return workspace.error;
  const prepared = prepareProjectList(options, workspace.value);
  if (!prepared.ok) return registration.usageError(prepared.error.message);
  const token = registration.requireToken();
  if (!token.ok) return token.error;
  const reader = registration.dependencies.projectReader;
  if (!reader) return internalError("Project reader is required");
  const listed = await executeProjectList(token.value, prepared.value, {
    reader,
  });
  if (!listed.ok) {
    return asanaFailure(listed.error);
  }
  return {
    stdout: invocation.json
      ? renderJson(listed.value.projects, listed.value.meta)
      : renderProjectList(listed.value.projects),
    stderr: invocation.json
      ? ""
      : renderListContinuation(listed.value.meta, ["projects", "list"], {
          ...options,
          workspace: prepared.value.workspaceGid,
        }),
    exitCode: 0,
  };
};

const finish = (
  command: Command,
  registration: ProjectCommandRegistration,
): void => {
  command.exitOverride();
  command.configureOutput(registration.outputConfiguration);
};

const registerProjectGet = (
  projects: Command,
  registration: ProjectCommandRegistration,
): Command => {
  const command = projects
    .command("get")
    .argument(PROJECT_ID_ARGUMENT, "project GID")
    .description("read a project's details")
    .action(async (idArg: string) => {
      registration.complete(await runProjectGet(idArg, registration));
    });
  withCommandCapabilities(command, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    errors: [...ASANA_ERROR_CODES, "not_found"],
  });
  return command;
};

const registerProjectSections = (
  projects: Command,
  registration: ProjectCommandRegistration,
): Command => {
  const command = projects
    .command("sections")
    .argument(PROJECT_ID_ARGUMENT, "project GID")
    .description("list a project's sections")
    .addOption(
      new Option(
        "--max <n>",
        "cap sections scanned; alone does not return all",
      ),
    )
    .option("--offset <token>", "resume from an Asana offset")
    .option("--all", "return all sections within the scan cap; requires --max")
    .action(async (idArg: string, options: ListOptions) => {
      registration.complete(
        await runProjectSections(idArg, options, registration),
      );
    });
  withCommandCapabilities(command, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    errors: [...ASANA_ERROR_CODES, "not_found"],
  });
  return command;
};

const registerProjectCustomFields = (
  projects: Command,
  registration: ProjectCommandRegistration,
): Command => {
  const command = projects
    .command("custom-fields")
    .argument(PROJECT_ID_ARGUMENT, "project GID")
    .description("list a project's custom-field settings")
    .addOption(
      new Option(
        "--max <n>",
        "cap custom-field settings scanned; alone does not return all",
      ),
    )
    .option("--offset <token>", "resume from an Asana offset")
    .option(
      "--all",
      "return all custom-field settings within the scan cap; requires --max",
    )
    .addHelpText(
      "after",
      "\nGlobal options:\n  --json             output JSON\n  --fields <fields>  select explicit Asana fields",
    )
    .action(async (idArg: string, options: ListOptions) => {
      registration.complete(
        await runProjectCustomFields(idArg, options, registration),
      );
    });
  withCommandCapabilities(command, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    errors: [...ASANA_ERROR_CODES, "not_found"],
  });
  return command;
};

const registerProjectList = (
  projects: Command,
  registration: ProjectCommandRegistration,
): Command => {
  const command = projects
    .command("list")
    .description("list projects visible in a workspace")
    .addOption(new Option("--workspace <gid>", "workspace GID"))
    .addOption(
      new Option(
        "--max <n>",
        "cap projects scanned; alone does not return all",
      ),
    )
    .option("--offset <token>", "resume from an Asana offset")
    .option("--all", "return all projects within the scan cap; requires --max")
    .action(async (options: ProjectListOptions) => {
      registration.complete(await runProjectList(options, registration));
    });
  withCommandCapabilities(command, {
    operation: "read",
    requirements: {
      authentication: "required",
      configuration: "conditional",
    },
    errors: [...ASANA_ERROR_CODES, "configuration"],
  });
  return command;
};

export const registerProjectCommands = (
  registration: ProjectCommandRegistration,
): void => {
  const projects = registration.program
    .command("projects")
    .description("inspect projects");
  withCommandCapabilities(projects, {
    operation: "read",
    requirements: {
      authentication: "required",
      configuration: "conditional",
    },
  });

  const commands = [
    projects,
    registerProjectGet(projects, registration),
    registerProjectSections(projects, registration),
    registerProjectCustomFields(projects, registration),
    registerProjectList(projects, registration),
  ];

  for (const command of commands) {
    finish(command, registration);
  }
};

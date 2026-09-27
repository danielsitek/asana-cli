import { Option, type Command, type OutputConfiguration } from "commander";

import { resolveConfig } from "../config/index.ts";
import type { IdentityError } from "../identity/index.ts";
import {
  renderError,
  renderJson,
  renderProjectCustomFieldSettingList,
  renderProjectCustomFieldSettingListScanWarning,
  renderProjectDetail,
  renderProjectList,
  renderProjectListScanWarning,
  renderProjectSectionList,
  renderProjectSectionListScanWarning,
} from "../output/index.ts";
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
  type ProjectReadError,
} from "../projects/index.ts";
import type { Result } from "../shared/result.ts";
import { validateFieldList } from "../tasks/index.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import { renderConfigFailure } from "./config-error.ts";
import type { ExecuteDependencies, Execution } from "./contracts.ts";

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
  complete: (execution: Execution) => void;
  requireToken: () => Result<string, Execution>;
  renderIdentityFailure: (kind: IdentityError["kind"]) => Execution;
  usageError: (message: string) => Execution;
  outputConfiguration: OutputConfiguration;
}>;

type BoundedOptions = Readonly<{ max?: string; all?: boolean }>;
type ProjectListOptions = BoundedOptions & Readonly<{ workspace?: string }>;

const PROJECT_ID_ARGUMENT = "<id>";

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

const internalError = (message: string): Execution => ({
  stdout: "",
  stderr: renderError({ code: "internal_error", message }),
  exitCode: 6,
});

const selectedFields = (
  fields: string | undefined,
  defaults: readonly string[],
  usageError: (message: string) => Execution,
): Result<readonly string[], Execution> => {
  if (fields === undefined) return { ok: true, value: defaults };
  const validated = validateFieldList(fields);
  return validated.ok
    ? validated
    : { ok: false, error: usageError(validated.error) };
};

const runProjectGet = async (
  idArg: string,
  registration: ProjectCommandRegistration,
): Promise<Execution> => {
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
  if (!project.ok) return renderProjectReadFailure(project.error.kind);
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
  options: BoundedOptions,
  registration: ProjectCommandRegistration,
): Promise<Execution> => {
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
  if (!listed.ok) return renderProjectReadFailure(listed.error.kind);
  return {
    stdout: invocation.json
      ? renderJson(listed.value.sections, listed.value.meta)
      : renderProjectSectionList(listed.value.sections, prepared.value.fields),
    stderr: invocation.json
      ? ""
      : renderProjectSectionListScanWarning(listed.value.meta.scan_truncated),
    exitCode: 0,
  };
};

const runProjectCustomFields = async (
  idArg: string,
  options: BoundedOptions,
  registration: ProjectCommandRegistration,
): Promise<Execution> => {
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
  if (!listed.ok) return renderProjectReadFailure(listed.error.kind);
  return {
    stdout: invocation.json
      ? renderJson(listed.value.settings, listed.value.meta)
      : renderProjectCustomFieldSettingList(
          listed.value.settings,
          prepared.value.fields,
        ),
    stderr: invocation.json
      ? ""
      : renderProjectCustomFieldSettingListScanWarning(
          listed.value.meta.scan_truncated,
        ),
    exitCode: 0,
  };
};

const configuredWorkspace = async (
  options: ProjectListOptions,
  registration: ProjectCommandRegistration,
): Promise<Result<string | undefined, Execution>> => {
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
): Promise<Execution> => {
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
    return registration.renderIdentityFailure(listed.error.kind);
  }
  return {
    stdout: invocation.json
      ? renderJson(listed.value.projects, listed.value.meta)
      : renderProjectList(listed.value.projects),
    stderr: invocation.json
      ? ""
      : renderProjectListScanWarning(listed.value.meta.scan_truncated),
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
    exitCodes: [0, 2, 3, 4, 5, 6],
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
    .addOption(new Option("--max <n>", "cap sections scanned"))
    .option("--all", "return all sections within the scan cap")
    .action(async (idArg: string, options: BoundedOptions) => {
      registration.complete(
        await runProjectSections(idArg, options, registration),
      );
    });
  withCommandCapabilities(command, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    exitCodes: [0, 2, 3, 4, 5, 6],
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
    .addOption(new Option("--max <n>", "cap custom-field settings scanned"))
    .option("--all", "return all custom-field settings within the scan cap")
    .addHelpText(
      "after",
      "\nGlobal options:\n  --json             output JSON\n  --fields <fields>  select explicit Asana fields",
    )
    .action(async (idArg: string, options: BoundedOptions) => {
      registration.complete(
        await runProjectCustomFields(idArg, options, registration),
      );
    });
  withCommandCapabilities(command, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    exitCodes: [0, 2, 3, 4, 5, 6],
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
    .addOption(new Option("--max <n>", "cap projects scanned"))
    .option("--all", "return all projects within the scan cap")
    .action(async (options: ProjectListOptions) => {
      registration.complete(await runProjectList(options, registration));
    });
  withCommandCapabilities(command, {
    operation: "read",
    requirements: {
      authentication: "required",
      configuration: "conditional",
    },
    exitCodes: [0, 2, 3, 4, 5, 6],
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
    exitCodes: [0, 2, 3, 4, 5, 6],
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

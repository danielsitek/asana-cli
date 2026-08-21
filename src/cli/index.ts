import { Command, CommanderError, Option } from "commander";
import { readFile } from "node:fs/promises";

import { resolveToken } from "../auth/index.ts";
import {
  COMPLETION_SHELLS,
  isCompletionShell,
  renderCompletion,
} from "../completion/index.ts";
import {
  getConfigValue,
  initializeSharedConfig,
  initializeLocalConfig,
  resolveConfig,
  setConfigValue,
  type ConfigContext,
  type ConfigError,
  type ConfigLayer,
  type LocalConfigInitResult,
  type MyTaskSectionsDiscoveryGateway,
  type MyTasksDiscoveryGateway,
  type StageFailureError,
} from "../config/index.ts";
import type {
  IdentityError as AsanaError,
  IdentityGateway,
} from "../identity/index.ts";
import {
  createMyTasksMutationResolver,
  createMySectionResolver,
} from "../my-tasks/index.ts";
import {
  type TaskCommentCreationGateway,
  type TaskStoryGateway,
  executeTaskCommentCreate,
  executeTaskCommentsRead,
  prepareTaskCommentCreate,
  prepareTaskCommentsRead,
} from "../comments/index.ts";
import {
  type TaskGateway,
  type TaskCreationGateway,
  type TaskListGateway,
  type TaskMutationGateway,
  type TaskParentMutationGateway,
  type TaskProjectMutationGateway,
  type TaskSectionMutationGateway,
  type TaskReadError,
  type TaskUpdateError,
  type TaskUpdateOptions,
  executeTaskUpdate,
  executeTaskCreation,
  executeTaskParentUpdate,
  executeTaskListRead,
  parseTaskId,
  prepareTaskUpdate,
  prepareTaskParentUpdate,
  prepareTaskCreateWithConfig,
  prepareTaskListRead,
  validateFieldList,
  DEFAULT_FIELDS,
} from "../tasks/index.ts";
import {
  renderConfig,
  renderConfigValue,
  renderError,
  renderIdentity,
  renderJson,
  renderResolvedMyTasks,
  renderCommentDetail,
  renderCommentList,
  renderCommentScanWarning,
  renderTaskDetail,
  renderTaskUpdate,
  renderTaskCreation,
  renderTaskList,
  renderTaskListScanWarning,
  renderProjectList,
  renderProjectDetail,
  renderProjectListScanWarning,
  renderWorkspaceList,
} from "../output/index.ts";
import {
  executeProjectList,
  DEFAULT_PROJECT_FIELDS,
  parseProjectGid,
  prepareProjectList,
  type ProjectGateway,
  type ProjectReadGateway,
  type ProjectReadError,
} from "../projects/index.ts";
import type { Result } from "../shared/result.ts";
import { acceptsFieldsOptionAtPath } from "./field-selection.ts";
import {
  executeWorkspacesList,
  type WorkspaceGateway,
} from "../workspaces/index.ts";

export type Execution = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export type ExecuteDependencies = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  identity: IdentityGateway;
  taskReader?: TaskGateway;
  taskCreator?: TaskCreationGateway;
  taskWriter?: TaskMutationGateway;
  taskParentWriter?: TaskParentMutationGateway;
  taskProjectWriter?: TaskProjectMutationGateway;
  taskSectionWriter?: TaskSectionMutationGateway;
  taskListReader?: TaskListGateway;
  commentReader?: TaskStoryGateway;
  commentWriter?: TaskCommentCreationGateway;
  workspaceReader?: WorkspaceGateway;
  projectReader?: ProjectGateway;
  projectDetailReader?: ProjectReadGateway;
  readFile?: (path: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  discovery?: MyTasksDiscoveryGateway;
  myTaskSectionsDiscovery?: MyTaskSectionsDiscoveryGateway;
  configuration?: ConfigContext;
  version?: string;
}>;

type TaskMutationCliOptions = Readonly<{
  name?: string;
  notes?: string;
  notesFile?: string;
  assignee?: string;
  dueOn?: string;
  completed?: string;
  mySection?: string;
  section?: string;
  project?: string;
  customField?: readonly string[];
}>;

const withTaskMutationOptions = (command: Command): Command =>
  command
    .option("--name <text>", "set the task name")
    .option("--notes <text>", "replace task notes")
    .option("--notes-file <path>", "replace notes from a file or stdin with -")
    .option("--assignee <value>", "set me, a user GID, or null")
    .option("--due-on <date>", "set YYYY-MM-DD or null")
    .option("--completed <boolean>", "set true or false")
    .option("--my-section <section>", "move within My Tasks by GID or @alias")
    .option("--section <gid>", "place or move in any project section")
    .option(
      "--custom-field <field:value>",
      "set a number or enum My Tasks custom field by GID or @alias; enum value is an option GID or exact name; repeatable",
      (value: string, previous: readonly string[] | undefined) => [
        ...(previous ?? []),
        value,
      ],
    );

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

const taskReadFailures: Readonly<
  Record<TaskReadError["kind"], Readonly<{ exitCode: number; message: string }>>
> = {
  authentication: { exitCode: 3, message: "Asana authentication failed" },
  api: { exitCode: 4, message: "Asana API request failed" },
  not_found: { exitCode: 4, message: "Task not found" },
  rate_limit: { exitCode: 5, message: "Asana request retries exhausted" },
  network: { exitCode: 4, message: "Unable to reach Asana" },
  invalid_response: {
    exitCode: 4,
    message: "Asana returned an invalid response",
  },
};

const renderTaskReadFailure = (kind: TaskReadError["kind"]): Execution => {
  const mapped = taskReadFailures[kind];
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

const renderConfigFailure = (error: ConfigError): Execution => ({
  stdout: "",
  stderr: renderError({ code: "configuration", message: error.message }),
  exitCode: 2,
});

const renderTaskWorkflowFailure = (error: TaskUpdateError): Execution => {
  if (error.kind === "invalid_usage") return usageError(error.message);
  if (error.kind === "configuration") return renderConfigFailure(error);
  if (error.kind === "internal_error") {
    return {
      stdout: "",
      stderr: renderError({
        code: "internal_error",
        message: error.message,
      }),
      exitCode: 6,
    };
  }
  return renderTaskReadFailure(error.kind);
};

const renderStageFailure = (
  error: StageFailureError,
  json: boolean,
): Execution => {
  if (json) {
    return {
      stdout: renderJson({
        completed: error.completed,
        failed: error.failed,
        message: error.message,
      }),
      stderr: "",
      exitCode: 1,
    };
  }

  const completedList = [...error.completed].sort().join(", ");
  const failedList = [...error.failed].sort().join(", ");
  return {
    stdout: `Stage failure: ${error.message}\nCompleted: ${completedList || "none"}\nFailed: ${failedList || "none"}\n`,
    stderr: "",
    exitCode: 1,
  };
};

const requireConfig = async (
  context: ConfigContext,
  dependencies: Pick<ExecuteDependencies, "environment" | "discovery">,
  options: Readonly<{ writeGitignore?: boolean }>,
  json: boolean,
): Promise<Result<LocalConfigInitResult, Execution>> => {
  const token = requireToken(dependencies);
  if (!token.ok) return token;

  const discovery = dependencies.discovery;
  if (!discovery) {
    return {
      ok: false,
      error: {
        stdout: "",
        stderr: renderError({
          code: "internal_error",
          message: "Discovery gateway is required",
        }),
        exitCode: 6,
      },
    };
  }

  const initialized = await initializeLocalConfig(
    context,
    token.value,
    discovery,
    options,
  );
  if (initialized.ok) return initialized;
  if (initialized.error.kind === "configuration") {
    return { ok: false, error: renderConfigFailure(initialized.error) };
  }
  if (initialized.error.kind === "stage_failure") {
    return { ok: false, error: renderStageFailure(initialized.error, json) };
  }
  return { ok: false, error: renderIdentityFailure(initialized.error.kind) };
};

const selectedLayer = (
  options: Readonly<{
    shared?: boolean;
    local?: boolean;
    global?: boolean;
  }>,
): Result<ConfigLayer | undefined, string> => {
  const selected = (
    [
      ["shared", options.shared],
      ["local", options.local],
      ["global", options.global],
    ] as const
  ).filter(([, enabled]) => enabled);
  return selected.length > 1
    ? {
        ok: false,
        error: "--shared, --local, and --global are mutually exclusive",
      }
    : { ok: true, value: selected[0]?.[0] };
};

export const execute = async (
  argv: readonly string[],
  dependencies: ExecuteDependencies,
): Promise<Execution> => {
  const program = new Command()
    .name("asana-cli")
    .version(dependencies.version ?? "0.3.1", "-v, --version");
  const version = dependencies.version ?? "0.3.1";
  let json = false;
  const invokedState = { value: false };
  let result: Execution | undefined;
  let parserStdout = "";

  const stopWith = (execution: Execution): void => {
    result = execution;
  };

  const beginConfigCommand = (): ConfigContext | undefined => {
    invokedState.value = true;
    json = program.opts<{ json?: boolean }>().json ?? false;
    const context = dependencies.configuration;
    if (!context) result = usageError("Configuration context is unavailable");
    return context;
  };

  const captureOutput = {
    writeOut: (text: string) => {
      parserStdout += text;
    },
    writeErr: () => undefined,
  };

  const resolveAuthenticatedUserGid = async (token: string) => {
    const identity = await dependencies.identity.getAuthenticatedUser(token);
    return identity.ok
      ? { ok: true as const, value: identity.value.gid }
      : identity;
  };

  const myTasksMutationResolverFor = (required: boolean) => {
    if (!required) return undefined;
    const configuration = dependencies.configuration;
    const discovery = dependencies.discovery;
    const reader = dependencies.taskReader;
    return configuration && discovery
      ? createMyTasksMutationResolver({
          configuration,
          discovery,
          ...(reader ? { reader } : {}),
          resolveAuthenticatedUserGid,
        })
      : undefined;
  };

  const mySectionResolverFor = (required: boolean) => {
    if (!required) return undefined;
    const configuration = dependencies.configuration;
    const discovery = dependencies.myTaskSectionsDiscovery;
    return configuration && discovery
      ? createMySectionResolver({ configuration, discovery })
      : undefined;
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
  whoami.version(version, "-v, --version");

  const config = program
    .command("config")
    .description("manage layered configuration");

  config
    .command("init")
    .description("initialize configuration")
    .option("--shared", "initialize shared repository configuration")
    .option("--local", "initialize local repository configuration")
    .option("--workspace <gid>", "Asana workspace GID")
    .option(
      "--write-gitignore",
      "automatically ignore the local configuration file",
    )
    .action(
      async (
        options: Readonly<{
          shared?: boolean;
          local?: boolean;
          workspace?: string;
          writeGitignore?: boolean;
        }>,
      ) => {
        const context = beginConfigCommand();
        if (!context) return;

        if (options.shared && options.local) {
          result = usageError("--shared and --local are mutually exclusive");
          return;
        }
        if (!options.shared && !options.local) {
          result = usageError(
            "config init requires either --shared or --local",
          );
          return;
        }
        if (options.writeGitignore && !options.local) {
          result = usageError("--write-gitignore requires --local");
          return;
        }
        if (options.local && options.workspace !== undefined) {
          result = usageError("--workspace is not supported with --local");
          return;
        }

        if (options.shared) {
          const initialized = await initializeSharedConfig(
            context,
            options.workspace,
          );
          if (!initialized.ok) {
            result = renderConfigFailure(initialized.error);
            return;
          }
          result = {
            stdout: json
              ? renderJson(initialized.value)
              : `initialized ${initialized.value.path}\n`,
            stderr: "",
            exitCode: 0,
          };
          return;
        }

        const initialized = await requireConfig(
          context,
          dependencies,
          options.writeGitignore !== undefined
            ? { writeGitignore: options.writeGitignore }
            : {},
          json,
        );
        if (!initialized.ok) {
          stopWith(initialized.error);
          return;
        }

        result = {
          stdout: json
            ? renderJson(initialized.value)
            : `initialized ${initialized.value.path}\n`,
          stderr: "",
          exitCode: 0,
        };
      },
    );

  const resolveCmd = config
    .command("resolve")
    .description("resolve configuration resources");

  resolveCmd
    .command("my-tasks")
    .description("resolve My Tasks configuration")
    .action(async () => {
      const context = beginConfigCommand();
      if (!context) return;

      const resolved = await requireConfig(context, dependencies, {}, json);
      if (!resolved.ok) {
        stopWith(resolved.error);
        return;
      }

      result = {
        stdout: json
          ? renderJson(resolved.value.myTasks)
          : renderResolvedMyTasks(resolved.value.myTasks),
        stderr: "",
        exitCode: 0,
      };
    });

  config
    .command("get")
    .description("read an effective configuration value")
    .argument("<key>", "dotted configuration key")
    .option("--source", "include the winning source")
    .action(async (key: string, options: Readonly<{ source?: boolean }>) => {
      const context = beginConfigCommand();
      if (!context) return;

      const resolved = await resolveConfig(context);
      if (!resolved.ok) {
        result = renderConfigFailure(resolved.error);
        return;
      }
      const found = getConfigValue(resolved.value, key);
      if (!found.ok) {
        result = renderConfigFailure(found.error);
        return;
      }
      result = {
        stdout: renderConfigValue(
          found.value.value,
          options.source ? found.value.source : undefined,
          options.source ? found.value.sources : {},
          json,
        ),
        stderr: "",
        exitCode: 0,
      };
    });

  config
    .command("set")
    .description("write a configuration value")
    .argument("<key>", "dotted configuration key")
    .argument("<value>", "configuration value")
    .option("--shared", "write shared repository configuration")
    .option("--local", "write personal repository configuration")
    .option("--global", "write global user configuration")
    .action(
      async (
        key: string,
        value: string,
        options: Readonly<{
          shared?: boolean;
          local?: boolean;
          global?: boolean;
        }>,
      ) => {
        const context = beginConfigCommand();
        if (!context) return;

        const layer = selectedLayer(options);
        if (!layer.ok) {
          result = usageError(layer.error);
          return;
        }
        const written = await setConfigValue(context, key, value, layer.value);
        if (!written.ok) {
          result = renderConfigFailure(written.error);
          return;
        }
        result = {
          stdout: json
            ? renderJson(written.value)
            : `updated ${written.value.path}\n`,
          stderr: "",
          exitCode: 0,
        };
      },
    );

  config
    .command("show")
    .description("show effective configuration")
    .option("--sources", "include the winning source for every value")
    .action(async (options: Readonly<{ sources?: boolean }>) => {
      const context = beginConfigCommand();
      if (!context) return;

      const resolved = await resolveConfig(context);
      if (!resolved.ok) {
        result = renderConfigFailure(resolved.error);
        return;
      }
      result = {
        stdout: renderConfig(
          resolved.value.value,
          resolved.value.sources,
          options.sources ?? false,
          json,
        ),
        stderr: "",
        exitCode: 0,
      };
    });

  const tasks = program.command("tasks").description("manage tasks");

  const tasksGet = tasks
    .command("get <id>")
    .description("read a task's details")
    .action(async (idArg: string) => {
      invokedState.value = true;
      json = program.opts<{ json?: boolean }>().json ?? false;

      const parsedId = parseTaskId(idArg);
      if (!parsedId.ok) {
        result = usageError("Invalid task identifier");
        return;
      }

      const customFieldsOpt = program.opts<{ fields?: string }>().fields;
      let fields: readonly string[];
      if (customFieldsOpt !== undefined) {
        const validated = validateFieldList(customFieldsOpt);
        if (!validated.ok) {
          result = usageError(validated.error);
          return;
        }
        fields = validated.value;
      } else {
        fields = DEFAULT_FIELDS;
      }

      const tokenResult = requireToken(dependencies);
      if (!tokenResult.ok) {
        stopWith(tokenResult.error);
        return;
      }

      if (!dependencies.taskReader) {
        result = {
          stdout: "",
          stderr: renderError({
            code: "internal_error",
            message: "Task reader is required",
          }),
          exitCode: 6,
        };
        return;
      }

      const taskResult = await dependencies.taskReader.getTask(
        tokenResult.value,
        parsedId.value,
        fields,
      );

      if (!taskResult.ok) {
        result = renderTaskReadFailure(taskResult.error.kind);
        return;
      }

      result = {
        stdout: json
          ? renderJson(taskResult.value)
          : renderTaskDetail(taskResult.value),
        stderr: "",
        exitCode: 0,
      };
    });

  tasksGet.exitOverride();
  tasksGet.configureOutput(captureOutput);

  const tasksUpdate = withTaskMutationOptions(
    tasks.command("update <id>").description("update a task's fields"),
  )
    .option(
      "--project <gid>",
      "add to a project by GID; exclusive with other flags",
    )
    .option(
      "--parent <id>",
      "reparent to a task GID or URL, or null to promote; exclusive with other flags",
    )
    .action(
      async (
        idArg: string,
        options: TaskMutationCliOptions & Readonly<{ parent?: string }>,
      ) => {
        invokedState.value = true;
        json = program.opts<{ json?: boolean }>().json ?? false;

        const fieldsInput = program.opts<{ fields?: string }>().fields;
        const { customField, parent, ...rest } = options;
        if (parent !== undefined) {
          result = await runTaskParentUpdate(
            idArg,
            {
              ...rest,
              parent,
              ...(customField ? { customFields: customField } : {}),
            },
            fieldsInput,
          );
          return;
        }

        result = await runTaskUpdate(idArg, options, fieldsInput);
      },
    );

  const runTaskParentUpdate = async (
    idArg: string,
    options: TaskUpdateOptions & Readonly<{ parent: string }>,
    fieldsInput?: string,
  ): Promise<Execution> => {
    const prepared = prepareTaskParentUpdate(idArg, options, fieldsInput);
    if (!prepared.ok) return usageError(prepared.error.message);

    const tokenResult = requireToken(dependencies);
    if (!tokenResult.ok) {
      return tokenResult.error;
    }
    if (!dependencies.taskParentWriter) {
      return {
        stdout: "",
        stderr: renderError({
          code: "internal_error",
          message: "Task parent writer is required",
        }),
        exitCode: 6,
      };
    }

    const updated = await executeTaskParentUpdate(
      tokenResult.value,
      prepared.value,
      { writer: dependencies.taskParentWriter },
    );
    if (!updated.ok) return renderTaskWorkflowFailure(updated.error);
    return {
      stdout: json
        ? renderJson(updated.value.task, { applied: updated.value.applied })
        : renderTaskUpdate(updated.value.task, updated.value.applied),
      stderr: "",
      exitCode: 0,
    };
  };

  const runTaskUpdate = async (
    idArg: string,
    options: TaskMutationCliOptions,
    fieldsInput?: string,
  ): Promise<Execution> => {
    const { customField, ...rest } = options;
    const prepared = prepareTaskUpdate(
      idArg,
      {
        ...rest,
        ...(customField ? { customFields: customField } : {}),
      },
      fieldsInput,
    );
    if (!prepared.ok) return usageError(prepared.error.message);

    const tokenResult = requireToken(dependencies);
    if (!tokenResult.ok) {
      return tokenResult.error;
    }
    if (!dependencies.taskWriter) {
      return {
        stdout: "",
        stderr: renderError({
          code: "internal_error",
          message: "Task writer is required",
        }),
        exitCode: 6,
      };
    }

    const hasMyTasksMutation =
      prepared.value.mySection !== undefined ||
      prepared.value.customFields.length > 0;
    const myTasksMutationResolver =
      myTasksMutationResolverFor(hasMyTasksMutation);

    const updated = await executeTaskUpdate(tokenResult.value, prepared.value, {
      writer: dependencies.taskWriter,
      ...(dependencies.taskSectionWriter
        ? { sectionWriter: dependencies.taskSectionWriter }
        : {}),
      ...(dependencies.taskProjectWriter
        ? { projectWriter: dependencies.taskProjectWriter }
        : {}),
      ...(myTasksMutationResolver ? { myTasksMutationResolver } : {}),
      resolveAuthenticatedUserGid,
      readFile:
        dependencies.readFile ??
        ((path) => readFile(path, { encoding: "utf8" })),
      readStdin: dependencies.readStdin ?? (() => Bun.stdin.text()),
    });
    if (!updated.ok) return renderTaskWorkflowFailure(updated.error);
    return {
      stdout: json
        ? renderJson(updated.value.task, {
            applied: updated.value.applied,
          })
        : renderTaskUpdate(updated.value.task, updated.value.applied),
      stderr: "",
      exitCode: 0,
    };
  };

  tasksUpdate.exitOverride();
  tasksUpdate.configureOutput(captureOutput);

  const tasksCreate = withTaskMutationOptions(
    tasks
      .command("create")
      .description("create a task or subtask")
      .option("--parent <id>", "parent task GID or URL")
      .option("--project <gid>", "destination project GID"),
  ).action(
    async (
      options: TaskMutationCliOptions &
        Readonly<{ parent?: string; project?: string }>,
    ) => {
      invokedState.value = true;
      json = program.opts<{ json?: boolean }>().json ?? false;

      const prepared = await prepareTaskCreateWithConfig(
        {
          ...options,
          ...(options.customField ? { customFields: options.customField } : {}),
        },
        async () => {
          const configuration = dependencies.configuration;
          if (!configuration) {
            return { ok: true as const, value: {} };
          }
          const resolved = await resolveConfig(configuration);
          return resolved.ok
            ? {
                ok: true as const,
                value: {
                  ...(resolved.value.value.defaultAssignee === undefined
                    ? {}
                    : {
                        defaultAssignee: resolved.value.value.defaultAssignee,
                      }),
                  ...(resolved.value.value.workspace?.gid === undefined
                    ? {}
                    : { workspaceGid: resolved.value.value.workspace.gid }),
                },
              }
            : resolved;
        },
        program.opts<{ fields?: string }>().fields,
      );
      if (!prepared.ok) {
        result =
          prepared.error.kind === "configuration"
            ? renderConfigFailure(prepared.error)
            : usageError(prepared.error.message);
        return;
      }

      const tokenResult = requireToken(dependencies);
      if (!tokenResult.ok) {
        stopWith(tokenResult.error);
        return;
      }
      if (!dependencies.taskCreator) {
        result = {
          stdout: "",
          stderr: renderError({
            code: "internal_error",
            message: "Task creator is required",
          }),
          exitCode: 6,
        };
        return;
      }

      const hasMyTasksMutation =
        prepared.value.mySection !== undefined ||
        prepared.value.customFields.length > 0;
      const myTasksMutationResolver =
        myTasksMutationResolverFor(hasMyTasksMutation);
      const created = await executeTaskCreation(
        tokenResult.value,
        prepared.value,
        {
          creator: dependencies.taskCreator,
          ...(dependencies.taskWriter
            ? { writer: dependencies.taskWriter }
            : {}),
          ...(myTasksMutationResolver ? { myTasksMutationResolver } : {}),
          resolveAuthenticatedUserGid,
          readFile:
            dependencies.readFile ??
            ((path) => readFile(path, { encoding: "utf8" })),
          readStdin: dependencies.readStdin ?? (() => Bun.stdin.text()),
        },
      );
      if (!created.ok) {
        result = renderTaskWorkflowFailure(created.error);
        return;
      }

      result = {
        stdout: json
          ? renderJson(created.value.task, { stages: created.value.stages })
          : renderTaskCreation(created.value.task, created.value.stages),
        stderr: "",
        exitCode: created.value.complete ? 0 : 1,
      };
    },
  );

  tasksCreate.exitOverride();
  tasksCreate.configureOutput(captureOutput);

  const tasksComments = tasks
    .command("comments <id>")
    .description("read task comments")
    .option("--max <n>", "cap stories scanned")
    .option("--offset <token>", "start from an Asana offset")
    .option("--all", "return all comments within the scan cap")
    .option(
      "--latest <n>",
      "return the newest N comments after exhausting the source within --max",
    )
    .action(
      async (
        idArg: string,
        options: Readonly<{
          max?: string;
          offset?: string;
          all?: boolean;
          latest?: string;
        }>,
      ) => {
        invokedState.value = true;
        json = program.opts<{ json?: boolean }>().json ?? false;
        const prepared = prepareTaskCommentsRead(idArg, {
          ...(program.opts<{ fields?: string }>().fields === undefined
            ? {}
            : { fields: program.opts<{ fields?: string }>().fields }),
          ...(options.max === undefined ? {} : { max: options.max }),
          ...(options.offset === undefined ? {} : { offset: options.offset }),
          ...(options.all === undefined ? {} : { all: options.all }),
          ...(options.latest === undefined ? {} : { latest: options.latest }),
        });
        if (!prepared.ok) {
          stopWith(usageError(prepared.error.message));
          return;
        }
        const tokenResult = requireToken(dependencies);
        if (!tokenResult.ok) {
          stopWith(tokenResult.error);
          return;
        }
        if (!dependencies.commentReader) {
          result = {
            stdout: "",
            stderr: renderError({
              code: "internal_error",
              message: "Comment reader is required",
            }),
            exitCode: 6,
          };
          return;
        }
        const read = await executeTaskCommentsRead(
          tokenResult.value,
          prepared.value,
          {
            reader: dependencies.commentReader,
          },
        );
        if (!read.ok) {
          result =
            read.error.kind === "scan_limit"
              ? {
                  stdout: "",
                  stderr: renderError({
                    code: "scan_limit",
                    message: read.error.message,
                  }),
                  exitCode: 5,
                }
              : renderTaskReadFailure(read.error.kind);
          return;
        }
        result = {
          stdout: json
            ? renderJson(read.value.comments, read.value.meta)
            : renderCommentList(
                read.value.comments,
                prepared.value.outputFields,
              ),
          stderr: json
            ? ""
            : renderCommentScanWarning(read.value.meta.scan_truncated),
          exitCode: 0,
        };
      },
    );

  tasksComments.exitOverride();
  tasksComments.configureOutput(captureOutput);

  const tasksComment = tasks
    .command("comment <id> [text]")
    .description("create a task comment")
    .option("--file <path>", "read comment text from a file or stdin with -")
    .action(
      async (
        idArg: string,
        textArg: string | undefined,
        options: Readonly<{ file?: string }>,
      ) => {
        invokedState.value = true;
        json = program.opts<{ json?: boolean }>().json ?? false;
        const prepared = prepareTaskCommentCreate(idArg, {
          ...(program.opts<{ fields?: string }>().fields === undefined
            ? {}
            : { fields: program.opts<{ fields?: string }>().fields }),
          ...(textArg === undefined ? {} : { text: textArg }),
          ...(options.file === undefined ? {} : { file: options.file }),
        });
        if (!prepared.ok) {
          stopWith(usageError(prepared.error.message));
          return;
        }
        const tokenResult = requireToken(dependencies);
        if (!tokenResult.ok) {
          stopWith(tokenResult.error);
          return;
        }
        if (!dependencies.commentWriter) {
          result = {
            stdout: "",
            stderr: renderError({
              code: "internal_error",
              message: "Comment writer is required",
            }),
            exitCode: 6,
          };
          return;
        }
        const created = await executeTaskCommentCreate(
          tokenResult.value,
          prepared.value,
          {
            writer: dependencies.commentWriter,
            readFile:
              dependencies.readFile ??
              ((path) => readFile(path, { encoding: "utf8" })),
            readStdin: dependencies.readStdin ?? (() => Bun.stdin.text()),
          },
        );
        if (!created.ok) {
          result =
            created.error.kind === "invalid_usage"
              ? usageError(created.error.message)
              : renderTaskReadFailure(created.error.kind);
          return;
        }
        result = {
          stdout: json
            ? renderJson(created.value)
            : renderCommentDetail(created.value),
          stderr: "",
          exitCode: 0,
        };
      },
    );

  tasksComment.exitOverride();
  tasksComment.configureOutput(captureOutput);

  const tasksList = tasks
    .command("list")
    .description(
      "list tasks from a My Tasks section, section, project, or parent task",
    )
    .option("--my-section <alias>", "list a My Tasks section by @alias")
    .option("--section <gid>", "list a section by GID")
    .option("--project <gid>", "list a project by GID")
    .option("--parent <id>", "list a task's direct subtasks by GID or URL")
    .option("--assignee <value>", "filter by me or a user GID")
    .option("--completed <boolean>", "filter by completed true or false")
    .option("--max <n>", "cap tasks scanned")
    .option("--all", "return all tasks within the scan cap")
    .action(
      async (
        options: Readonly<{
          mySection?: string;
          section?: string;
          project?: string;
          parent?: string;
          assignee?: string;
          completed?: string;
          max?: string;
          all?: boolean;
        }>,
      ) => {
        invokedState.value = true;
        json = program.opts<{ json?: boolean }>().json ?? false;

        const prepared = prepareTaskListRead(
          {
            ...(options.mySection === undefined
              ? {}
              : { mySection: options.mySection }),
            ...(options.section === undefined
              ? {}
              : { section: options.section }),
            ...(options.project === undefined
              ? {}
              : { project: options.project }),
            ...(options.parent === undefined ? {} : { parent: options.parent }),
            ...(options.assignee === undefined
              ? {}
              : { assignee: options.assignee }),
            ...(options.completed === undefined
              ? {}
              : { completed: options.completed }),
            ...(options.max === undefined ? {} : { max: options.max }),
            ...(options.all === undefined ? {} : { all: options.all }),
          },
          program.opts<{ fields?: string }>().fields,
        );
        if (!prepared.ok) {
          stopWith(usageError(prepared.error.message));
          return;
        }

        const tokenResult = requireToken(dependencies);
        if (!tokenResult.ok) {
          stopWith(tokenResult.error);
          return;
        }

        if (!dependencies.taskListReader) {
          result = {
            stdout: "",
            stderr: renderError({
              code: "internal_error",
              message: "Task list reader is required",
            }),
            exitCode: 6,
          };
          return;
        }

        const mySectionResolver = mySectionResolverFor(
          prepared.value.source.kind === "my_section",
        );

        const listed = await executeTaskListRead(
          tokenResult.value,
          prepared.value,
          {
            reader: dependencies.taskListReader,
            ...(mySectionResolver ? { mySectionResolver } : {}),
            resolveAuthenticatedUserGid,
          },
        );
        if (!listed.ok) {
          result = renderTaskWorkflowFailure(listed.error);
          return;
        }
        result = {
          stdout: json
            ? renderJson(listed.value.tasks, listed.value.meta)
            : renderTaskList(listed.value.tasks, prepared.value.outputFields),
          stderr: json
            ? ""
            : renderTaskListScanWarning(listed.value.meta.scan_truncated),
          exitCode: 0,
        };
      },
    );

  tasksList.exitOverride();
  tasksList.configureOutput(captureOutput);

  const projects = program.command("projects").description("inspect projects");
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

  projectsGet.exitOverride();
  projectsGet.configureOutput(captureOutput);

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

  projectsList.exitOverride();
  projectsList.configureOutput(captureOutput);

  const workspaces = program
    .command("workspaces")
    .description("inspect workspaces");
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
  completion.exitOverride();
  completion.configureOutput(captureOutput);

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
  return (
    result ??
    (invokedState.value
      ? usageError("Command did not complete")
      : usageError("A command is required"))
  );
};

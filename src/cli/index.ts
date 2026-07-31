import { Command, CommanderError } from "commander";
import { readFile } from "node:fs/promises";

import { resolveToken } from "../auth/index.ts";
import {
  getConfigValue,
  initializeSharedConfig,
  initializeLocalConfig,
  resolveConfig,
  setConfigValue,
  type ConfigContext,
  type ConfigError,
  type ConfigLayer,
  type MyTasksDiscoveryGateway,
  type StageFailureError,
} from "../config/index.ts";
import type {
  IdentityError as AsanaError,
  IdentityGateway,
} from "../identity/index.ts";
import { createMyTasksMutationResolver } from "../my-tasks/index.ts";
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
  type TaskMutationGateway,
  type TaskReadError,
  type TaskUpdateError,
  executeTaskUpdate,
  executeTaskCreation,
  parseTaskId,
  prepareTaskUpdate,
  prepareTaskCreate,
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
} from "../output/index.ts";
import type { Result } from "../shared/result.ts";

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
  commentReader?: TaskStoryGateway;
  commentWriter?: TaskCommentCreationGateway;
  readFile?: (path: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  discovery?: MyTasksDiscoveryGateway;
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
    .option(
      "--custom-field <field:value>",
      "set a numeric My Tasks custom field; repeatable",
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
    .version(dependencies.version ?? "0.1.0", "-v, --version");
  const version = dependencies.version ?? "0.1.0";
  let json = false;
  let invoked = false;
  let result: Execution | undefined;
  let parserStdout = "";

  const beginConfigCommand = (): ConfigContext | undefined => {
    invoked = true;
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

  program.option("--json", "output JSON");
  program.option("--fields <fields>", "select explicit Asana fields");

  program.hook("preAction", (thisCommand, actionCommand) => {
    if (thisCommand.opts<{ fields?: string }>().fields !== undefined) {
      const isTasksGet =
        actionCommand.name() === "get" &&
        actionCommand.parent?.name() === "tasks";
      const isTasksComments =
        actionCommand.name() === "comments" &&
        actionCommand.parent?.name() === "tasks";
      const isTasksComment =
        actionCommand.name() === "comment" &&
        actionCommand.parent?.name() === "tasks";
      if (!isTasksGet && !isTasksComments && !isTasksComment) {
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
      invoked = true;
      json = program.opts<{ json?: boolean }>().json ?? false;
      const token = resolveToken(dependencies.environment);
      if (!token.ok) {
        result = {
          stdout: "",
          stderr: renderError({
            code: "authentication",
            message: token.error.message,
          }),
          exitCode: 3,
        };
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

        const tokenResult = resolveToken(dependencies.environment);
        if (!tokenResult.ok) {
          result = {
            stdout: "",
            stderr: renderError({
              code: "authentication",
              message: tokenResult.error.message,
            }),
            exitCode: 3,
          };
          return;
        }

        if (!dependencies.discovery) {
          result = {
            stdout: "",
            stderr: renderError({
              code: "internal_error",
              message: "Discovery gateway is required",
            }),
            exitCode: 6,
          };
          return;
        }

        const initialized = await initializeLocalConfig(
          context,
          tokenResult.value,
          dependencies.discovery,
          options.writeGitignore !== undefined
            ? { writeGitignore: options.writeGitignore }
            : {},
        );
        if (!initialized.ok) {
          if (initialized.error.kind === "configuration") {
            result = renderConfigFailure(initialized.error);
          } else if (initialized.error.kind === "stage_failure") {
            result = renderStageFailure(initialized.error, json);
          } else {
            result = renderIdentityFailure(initialized.error.kind);
          }
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

      const tokenResult = resolveToken(dependencies.environment);
      if (!tokenResult.ok) {
        result = {
          stdout: "",
          stderr: renderError({
            code: "authentication",
            message: tokenResult.error.message,
          }),
          exitCode: 3,
        };
        return;
      }

      if (!dependencies.discovery) {
        result = {
          stdout: "",
          stderr: renderError({
            code: "internal_error",
            message: "Discovery gateway is required",
          }),
          exitCode: 6,
        };
        return;
      }

      const resolved = await initializeLocalConfig(
        context,
        tokenResult.value,
        dependencies.discovery,
        {},
      );
      if (!resolved.ok) {
        if (resolved.error.kind === "configuration") {
          result = renderConfigFailure(resolved.error);
        } else if (resolved.error.kind === "stage_failure") {
          result = renderStageFailure(resolved.error, json);
        } else {
          result = renderIdentityFailure(resolved.error.kind);
        }
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
      invoked = true;
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

      const tokenResult = resolveToken(dependencies.environment);
      if (!tokenResult.ok) {
        result = {
          stdout: "",
          stderr: renderError({
            code: "authentication",
            message: tokenResult.error.message,
          }),
          exitCode: 3,
        };
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
  ).action(async (idArg: string, options: TaskMutationCliOptions) => {
    invoked = true;
    json = program.opts<{ json?: boolean }>().json ?? false;

    const prepared = prepareTaskUpdate(idArg, {
      ...options,
      ...(options.customField ? { customFields: options.customField } : {}),
    });
    if (!prepared.ok) {
      result = usageError(prepared.error.message);
      return;
    }

    const tokenResult = resolveToken(dependencies.environment);
    if (!tokenResult.ok) {
      result = {
        stdout: "",
        stderr: renderError({
          code: "authentication",
          message: tokenResult.error.message,
        }),
        exitCode: 3,
      };
      return;
    }
    if (!dependencies.taskWriter) {
      result = {
        stdout: "",
        stderr: renderError({
          code: "internal_error",
          message: "Task writer is required",
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

    const updated = await executeTaskUpdate(tokenResult.value, prepared.value, {
      writer: dependencies.taskWriter,
      ...(myTasksMutationResolver ? { myTasksMutationResolver } : {}),
      resolveAuthenticatedUserGid,
      readFile:
        dependencies.readFile ??
        ((path) => readFile(path, { encoding: "utf8" })),
      readStdin: dependencies.readStdin ?? (() => Bun.stdin.text()),
    });
    if (!updated.ok) {
      result = renderTaskWorkflowFailure(updated.error);
      return;
    }
    result = {
      stdout: json
        ? renderJson(updated.value.task, {
            applied: updated.value.applied,
          })
        : renderTaskUpdate(updated.value.task, updated.value.applied),
      stderr: "",
      exitCode: 0,
    };
  });

  tasksUpdate.exitOverride();
  tasksUpdate.configureOutput(captureOutput);

  const tasksCreate = withTaskMutationOptions(
    tasks
      .command("create")
      .description("create a subtask")
      .option("--parent <id>", "parent task GID or URL"),
  ).action(
    async (options: TaskMutationCliOptions & Readonly<{ parent?: string }>) => {
      invoked = true;
      json = program.opts<{ json?: boolean }>().json ?? false;

      const prepared = prepareTaskCreate({
        ...options,
        ...(options.customField ? { customFields: options.customField } : {}),
      });
      if (!prepared.ok) {
        result = usageError(prepared.error.message);
        return;
      }

      const tokenResult = resolveToken(dependencies.environment);
      if (!tokenResult.ok) {
        result = {
          stdout: "",
          stderr: renderError({
            code: "authentication",
            message: tokenResult.error.message,
          }),
          exitCode: 3,
        };
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
    .action(
      async (
        idArg: string,
        options: Readonly<{ max?: string; offset?: string; all?: boolean }>,
      ) => {
        invoked = true;
        json = program.opts<{ json?: boolean }>().json ?? false;
        const prepared = prepareTaskCommentsRead(idArg, {
          ...(program.opts<{ fields?: string }>().fields === undefined
            ? {}
            : { fields: program.opts<{ fields?: string }>().fields }),
          ...(options.max === undefined ? {} : { max: options.max }),
          ...(options.offset === undefined ? {} : { offset: options.offset }),
          ...(options.all === undefined ? {} : { all: options.all }),
        });
        if (!prepared.ok) {
          result = usageError(prepared.error.message);
          return;
        }
        const tokenResult = resolveToken(dependencies.environment);
        if (!tokenResult.ok) {
          result = {
            stdout: "",
            stderr: renderError({
              code: "authentication",
              message: tokenResult.error.message,
            }),
            exitCode: 3,
          };
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
          result = renderTaskReadFailure(read.error.kind);
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
        invoked = true;
        json = program.opts<{ json?: boolean }>().json ?? false;
        const prepared = prepareTaskCommentCreate(idArg, {
          ...(program.opts<{ fields?: string }>().fields === undefined
            ? {}
            : { fields: program.opts<{ fields?: string }>().fields }),
          ...(textArg === undefined ? {} : { text: textArg }),
          ...(options.file === undefined ? {} : { file: options.file }),
        });
        if (!prepared.ok) {
          result = usageError(prepared.error.message);
          return;
        }
        const tokenResult = resolveToken(dependencies.environment);
        if (!tokenResult.ok) {
          result = {
            stdout: "",
            stderr: renderError({
              code: "authentication",
              message: tokenResult.error.message,
            }),
            exitCode: 3,
          };
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
    (invoked
      ? usageError("Command did not complete")
      : usageError("A command is required"))
  );
};

import { readFile } from "node:fs/promises";
import type { Command, OutputConfiguration } from "commander";

import {
  executeTaskCommentCreate,
  executeTaskCommentsRead,
  prepareTaskCommentCreate,
  prepareTaskCommentsRead,
} from "../comments/index.ts";
import { resolveConfig, type ConfigError } from "../config/index.ts";
import {
  createMySectionResolver,
  createMyTasksMutationResolver,
} from "../my-tasks/index.ts";
import {
  renderCommentDetail,
  renderCommentList,
  renderCommentScanWarning,
  renderError,
  renderJson,
  renderTaskCreation,
  renderTaskDetail,
  renderTaskList,
  renderTaskListScanWarning,
  renderTaskUpdate,
} from "../output/index.ts";
import type { Result } from "../shared/result.ts";
import {
  DEFAULT_FIELDS,
  executeTaskCreation,
  executeTaskListRead,
  executeTaskParentUpdate,
  executeTaskUpdate,
  parseTaskId,
  prepareTaskCreateWithConfig,
  prepareTaskListRead,
  prepareTaskParentUpdate,
  prepareTaskUpdate,
  type TaskReadError,
  type TaskUpdateError,
  type TaskUpdateOptions,
  validateFieldList,
} from "../tasks/index.ts";
import type { ExecuteDependencies, Execution } from "./contracts.ts";

type TaskCommandDependencies = Pick<
  ExecuteDependencies,
  | "identity"
  | "taskReader"
  | "taskCreator"
  | "taskWriter"
  | "taskParentWriter"
  | "taskProjectWriter"
  | "taskSectionWriter"
  | "taskListReader"
  | "commentReader"
  | "commentWriter"
  | "readFile"
  | "readStdin"
  | "discovery"
  | "myTaskSectionsDiscovery"
  | "configuration"
>;

type TaskInvocation = Readonly<{
  json: boolean;
  fields?: string;
}>;

type TaskCommandRegistration = Readonly<{
  program: Command;
  dependencies: TaskCommandDependencies;
  beginCommand: () => TaskInvocation;
  complete: (execution: Execution) => void;
  requireToken: () => Result<string, Execution>;
  usageError: (message: string) => Execution;
  outputConfiguration: OutputConfiguration;
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

const renderTaskWorkflowFailure = (
  error: TaskUpdateError,
  usageError: (message: string) => Execution,
): Execution => {
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

export const registerTaskCommands = ({
  program,
  dependencies,
  beginCommand,
  complete,
  requireToken,
  usageError,
  outputConfiguration,
}: TaskCommandRegistration): void => {
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

  const runTaskParentUpdate = async (
    idArg: string,
    options: TaskUpdateOptions & Readonly<{ parent: string }>,
    fieldsInput: string | undefined,
    json: boolean,
  ): Promise<Execution> => {
    const prepared = prepareTaskParentUpdate(idArg, options, fieldsInput);
    if (!prepared.ok) return usageError(prepared.error.message);

    const tokenResult = requireToken();
    if (!tokenResult.ok) return tokenResult.error;
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
    if (!updated.ok) {
      return renderTaskWorkflowFailure(updated.error, usageError);
    }
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
    fieldsInput: string | undefined,
    json: boolean,
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

    const tokenResult = requireToken();
    if (!tokenResult.ok) return tokenResult.error;
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
    if (!updated.ok) {
      return renderTaskWorkflowFailure(updated.error, usageError);
    }
    return {
      stdout: json
        ? renderJson(updated.value.task, { applied: updated.value.applied })
        : renderTaskUpdate(updated.value.task, updated.value.applied),
      stderr: "",
      exitCode: 0,
    };
  };

  const tasks = program.command("tasks").description("manage tasks");

  const tasksGet = tasks
    .command("get <id>")
    .description("read a task's details")
    .action(async (idArg: string) => {
      const { json, fields: fieldsInput } = beginCommand();

      const parsedId = parseTaskId(idArg);
      if (!parsedId.ok) {
        complete(usageError("Invalid task identifier"));
        return;
      }

      let fields: readonly string[];
      if (fieldsInput !== undefined) {
        const validated = validateFieldList(fieldsInput);
        if (!validated.ok) {
          complete(usageError(validated.error));
          return;
        }
        fields = validated.value;
      } else {
        fields = DEFAULT_FIELDS;
      }

      const tokenResult = requireToken();
      if (!tokenResult.ok) {
        complete(tokenResult.error);
        return;
      }

      if (!dependencies.taskReader) {
        complete({
          stdout: "",
          stderr: renderError({
            code: "internal_error",
            message: "Task reader is required",
          }),
          exitCode: 6,
        });
        return;
      }

      const taskResult = await dependencies.taskReader.getTask(
        tokenResult.value,
        parsedId.value,
        fields,
      );
      if (!taskResult.ok) {
        complete(renderTaskReadFailure(taskResult.error.kind));
        return;
      }
      complete({
        stdout: json
          ? renderJson(taskResult.value)
          : renderTaskDetail(taskResult.value),
        stderr: "",
        exitCode: 0,
      });
    });

  tasksGet.exitOverride();
  tasksGet.configureOutput(outputConfiguration);

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
        const { json, fields } = beginCommand();
        const { customField, parent, ...rest } = options;
        complete(
          parent !== undefined
            ? await runTaskParentUpdate(
                idArg,
                {
                  ...rest,
                  parent,
                  ...(customField ? { customFields: customField } : {}),
                },
                fields,
                json,
              )
            : await runTaskUpdate(idArg, options, fields, json),
        );
      },
    );

  tasksUpdate.exitOverride();
  tasksUpdate.configureOutput(outputConfiguration);

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
      const { json, fields } = beginCommand();
      const prepared = await prepareTaskCreateWithConfig(
        {
          ...options,
          ...(options.customField ? { customFields: options.customField } : {}),
        },
        async () => {
          const configuration = dependencies.configuration;
          if (!configuration) return { ok: true as const, value: {} };
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
        fields,
      );
      if (!prepared.ok) {
        complete(
          prepared.error.kind === "configuration"
            ? renderConfigFailure(prepared.error)
            : usageError(prepared.error.message),
        );
        return;
      }

      const tokenResult = requireToken();
      if (!tokenResult.ok) {
        complete(tokenResult.error);
        return;
      }
      if (!dependencies.taskCreator) {
        complete({
          stdout: "",
          stderr: renderError({
            code: "internal_error",
            message: "Task creator is required",
          }),
          exitCode: 6,
        });
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
        complete(renderTaskWorkflowFailure(created.error, usageError));
        return;
      }
      complete({
        stdout: json
          ? renderJson(created.value.task, { stages: created.value.stages })
          : renderTaskCreation(created.value.task, created.value.stages),
        stderr: "",
        exitCode: created.value.complete ? 0 : 1,
      });
    },
  );

  tasksCreate.exitOverride();
  tasksCreate.configureOutput(outputConfiguration);

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
        const { json, fields } = beginCommand();
        const prepared = prepareTaskCommentsRead(idArg, {
          ...(fields === undefined ? {} : { fields }),
          ...(options.max === undefined ? {} : { max: options.max }),
          ...(options.offset === undefined ? {} : { offset: options.offset }),
          ...(options.all === undefined ? {} : { all: options.all }),
          ...(options.latest === undefined ? {} : { latest: options.latest }),
        });
        if (!prepared.ok) {
          complete(usageError(prepared.error.message));
          return;
        }
        const tokenResult = requireToken();
        if (!tokenResult.ok) {
          complete(tokenResult.error);
          return;
        }
        if (!dependencies.commentReader) {
          complete({
            stdout: "",
            stderr: renderError({
              code: "internal_error",
              message: "Comment reader is required",
            }),
            exitCode: 6,
          });
          return;
        }
        const read = await executeTaskCommentsRead(
          tokenResult.value,
          prepared.value,
          { reader: dependencies.commentReader },
        );
        if (!read.ok) {
          complete(
            read.error.kind === "scan_limit"
              ? {
                  stdout: "",
                  stderr: renderError({
                    code: "scan_limit",
                    message: read.error.message,
                  }),
                  exitCode: 5,
                }
              : renderTaskReadFailure(read.error.kind),
          );
          return;
        }
        complete({
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
        });
      },
    );

  tasksComments.exitOverride();
  tasksComments.configureOutput(outputConfiguration);

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
        const { json, fields } = beginCommand();
        const prepared = prepareTaskCommentCreate(idArg, {
          ...(fields === undefined ? {} : { fields }),
          ...(textArg === undefined ? {} : { text: textArg }),
          ...(options.file === undefined ? {} : { file: options.file }),
        });
        if (!prepared.ok) {
          complete(usageError(prepared.error.message));
          return;
        }
        const tokenResult = requireToken();
        if (!tokenResult.ok) {
          complete(tokenResult.error);
          return;
        }
        if (!dependencies.commentWriter) {
          complete({
            stdout: "",
            stderr: renderError({
              code: "internal_error",
              message: "Comment writer is required",
            }),
            exitCode: 6,
          });
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
          complete(
            created.error.kind === "invalid_usage"
              ? usageError(created.error.message)
              : renderTaskReadFailure(created.error.kind),
          );
          return;
        }
        complete({
          stdout: json
            ? renderJson(created.value)
            : renderCommentDetail(created.value),
          stderr: "",
          exitCode: 0,
        });
      },
    );

  tasksComment.exitOverride();
  tasksComment.configureOutput(outputConfiguration);

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
        const { json, fields } = beginCommand();
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
          fields,
        );
        if (!prepared.ok) {
          complete(usageError(prepared.error.message));
          return;
        }

        const tokenResult = requireToken();
        if (!tokenResult.ok) {
          complete(tokenResult.error);
          return;
        }
        if (!dependencies.taskListReader) {
          complete({
            stdout: "",
            stderr: renderError({
              code: "internal_error",
              message: "Task list reader is required",
            }),
            exitCode: 6,
          });
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
          complete(renderTaskWorkflowFailure(listed.error, usageError));
          return;
        }
        complete({
          stdout: json
            ? renderJson(listed.value.tasks, listed.value.meta)
            : renderTaskList(listed.value.tasks, prepared.value.outputFields),
          stderr: json
            ? ""
            : renderTaskListScanWarning(listed.value.meta.scan_truncated),
          exitCode: 0,
        });
      },
    );

  tasksList.exitOverride();
  tasksList.configureOutput(outputConfiguration);
};

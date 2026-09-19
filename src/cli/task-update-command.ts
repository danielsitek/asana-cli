import {
  executeTaskParentUpdate,
  executeTaskUpdate,
  prepareTaskParentUpdate,
  prepareTaskUpdate,
  type TaskUpdateOptions,
} from "../tasks/index.ts";
import { renderJson, renderTaskUpdate } from "../output/index.ts";
import type { Execution } from "./contracts.ts";
import {
  internalError,
  myTasksMutationResolverFor,
  renderTaskWorkflowFailure,
  resolveAuthenticatedUserGid,
  taskFileReader,
  taskStdinReader,
  type TaskCommandContext,
  type TaskInvocation,
  type TaskMutationCliOptions,
} from "./task-command-context.ts";
import { withTaskMutationOptions } from "./task-mutation-options.ts";
import { withCommandCapabilities } from "./capabilities.ts";

const renderUpdatedTask = (
  json: boolean,
  task: Parameters<typeof renderTaskUpdate>[0],
  applied: Parameters<typeof renderTaskUpdate>[1],
): Execution => ({
  stdout: json
    ? renderJson(task, { applied })
    : renderTaskUpdate(task, applied),
  stderr: "",
  exitCode: 0,
});

const runTaskParentUpdate = async (
  context: TaskCommandContext,
  idArg: string,
  options: TaskUpdateOptions & Readonly<{ parent: string }>,
  invocation: TaskInvocation,
): Promise<Execution> => {
  const prepared = prepareTaskParentUpdate(idArg, options, invocation.fields);
  if (!prepared.ok) return context.usageError(prepared.error.message);
  const token = context.requireToken();
  if (!token.ok) return token.error;
  const writer = context.dependencies.taskParentWriter;
  if (!writer) return internalError("Task parent writer is required");
  const updated = await executeTaskParentUpdate(token.value, prepared.value, {
    writer,
  });
  return updated.ok
    ? renderUpdatedTask(
        invocation.json,
        updated.value.task,
        updated.value.applied,
      )
    : renderTaskWorkflowFailure(updated.error, context.usageError);
};

const taskUpdateDependencies = (
  context: TaskCommandContext,
  needsMyTasks: boolean,
) => {
  const dependencies = context.dependencies;
  const myTasksMutationResolver = myTasksMutationResolverFor(
    context,
    needsMyTasks,
  );
  return {
    writer: dependencies.taskWriter!,
    ...(dependencies.taskSectionWriter
      ? { sectionWriter: dependencies.taskSectionWriter }
      : {}),
    ...(dependencies.taskProjectWriter
      ? { projectWriter: dependencies.taskProjectWriter }
      : {}),
    ...(myTasksMutationResolver ? { myTasksMutationResolver } : {}),
    resolveAuthenticatedUserGid: (token: string) =>
      resolveAuthenticatedUserGid(context, token),
    readFile: taskFileReader(context),
    readStdin: taskStdinReader(context),
  };
};

const runTaskUpdate = async (
  context: TaskCommandContext,
  idArg: string,
  options: TaskMutationCliOptions,
  invocation: TaskInvocation,
): Promise<Execution> => {
  const { customField, ...rest } = options;
  const prepared = prepareTaskUpdate(
    idArg,
    { ...rest, ...(customField ? { customFields: customField } : {}) },
    invocation.fields,
  );
  if (!prepared.ok) return context.usageError(prepared.error.message);
  const token = context.requireToken();
  if (!token.ok) return token.error;
  if (!context.dependencies.taskWriter) {
    return internalError("Task writer is required");
  }
  const needsMyTasks =
    prepared.value.mySection !== undefined ||
    prepared.value.customFields.length > 0;
  const updated = await executeTaskUpdate(
    token.value,
    prepared.value,
    taskUpdateDependencies(context, needsMyTasks),
  );
  return updated.ok
    ? renderUpdatedTask(
        invocation.json,
        updated.value.task,
        updated.value.applied,
      )
    : renderTaskWorkflowFailure(updated.error, context.usageError);
};

const runSelectedUpdate = async (
  context: TaskCommandContext,
  idArg: string,
  options: TaskMutationCliOptions & Readonly<{ parent?: string }>,
): Promise<Execution> => {
  const invocation = context.beginCommand();
  const { customField, parent, ...rest } = options;
  if (parent === undefined) {
    return runTaskUpdate(context, idArg, options, invocation);
  }
  return runTaskParentUpdate(
    context,
    idArg,
    {
      ...rest,
      parent,
      ...(customField ? { customFields: customField } : {}),
    },
    invocation,
  );
};

export const registerTaskUpdateCommand = (
  context: TaskCommandContext,
): void => {
  const command = withTaskMutationOptions(
    context.tasks.command("update <id>").description("update a task's fields"),
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
      ) => context.complete(await runSelectedUpdate(context, idArg, options)),
    );
  withCommandCapabilities(command, {
    operation: "write",
    requirements: {
      authentication: "required",
      configuration: "conditional",
    },
    exitCodes: [0, 2, 3, 4, 5, 6],
    options: { customField: { repeatable: true } },
  });
  command.exitOverride();
  command.configureOutput(context.outputConfiguration);
};

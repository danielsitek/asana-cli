import { ASANA_ERROR_CODES } from "./errors.ts";
import {
  executeTaskParentUpdate,
  executeTaskUpdate,
  prepareTaskParentUpdate,
  prepareTaskUpdate,
  type TaskUpdateOptions,
} from "../tasks/index.ts";
import {
  previewTaskParentUpdate,
  previewTaskUpdate,
} from "../tasks/mutation-workflow.ts";
import { renderJson, renderTaskUpdate } from "../output/index.ts";
import type { CommandResult } from "./contracts.ts";
import { shellTextSafetyHelp } from "./shell-text-help.ts";
import {
  internalError,
  myTasksMutationResolverFor,
  renderTaskWorkflowFailure,
  renderTaskPreview,
  resolveAuthenticatedUserGid,
  taskFileReader,
  taskStdinReader,
  type TaskCommandContext,
  type TaskInvocation,
  type TaskMutationCliOptions,
} from "./task-command-context.ts";
import { withTaskMutationOptions } from "./task-mutation-options.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import { createProjectCustomFieldResolver } from "../tasks/project-custom-fields.ts";

const renderUpdatedTask = (
  json: boolean,
  task: Parameters<typeof renderTaskUpdate>[0],
  applied: Parameters<typeof renderTaskUpdate>[1],
): CommandResult => ({
  stdout: json
    ? renderJson(task, { applied })
    : renderTaskUpdate(task, applied),
  stderr: "",
  exitCode: 0,
});

const runTaskParentUpdate = async (
  context: TaskCommandContext,
  idArg: string,
  options: TaskUpdateOptions & Readonly<{ parent: string; dryRun?: boolean }>,
  invocation: TaskInvocation,
): Promise<CommandResult> => {
  const { dryRun, ...mutation } = options;
  const prepared = prepareTaskParentUpdate(idArg, mutation, invocation.fields);
  if (!prepared.ok) return context.usageError(prepared.error.message);
  const token = context.requireToken();
  if (!token.ok) return token.error;
  if (dryRun) {
    const reader = context.dependencies.taskReader;
    if (!reader) return internalError("Task reader is required");
    return renderTaskPreview(
      invocation.json,
      await previewTaskParentUpdate(token.value, prepared.value, reader),
      context.usageError,
    );
  }
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
  needsProjectFields: boolean,
) => {
  const dependencies = context.dependencies;
  const myTasksMutationResolver = myTasksMutationResolverFor(
    context,
    needsMyTasks,
  );
  return {
    ...(dependencies.taskSectionWriter
      ? { sectionWriter: dependencies.taskSectionWriter }
      : {}),
    ...(dependencies.taskProjectWriter
      ? { projectWriter: dependencies.taskProjectWriter }
      : {}),
    ...(myTasksMutationResolver ? { myTasksMutationResolver } : {}),
    ...(needsProjectFields &&
    dependencies.taskReader &&
    dependencies.projectCustomFieldSettingReader
      ? {
          projectCustomFieldResolver: createProjectCustomFieldResolver(
            dependencies.taskReader,
            dependencies.projectCustomFieldSettingReader,
          ),
        }
      : {}),
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
): Promise<CommandResult> => {
  const { customField, dryRun, ...rest } = options;
  const prepared = prepareTaskUpdate(
    idArg,
    { ...rest, ...(customField ? { customFields: customField } : {}) },
    invocation.fields,
  );
  if (!prepared.ok) return context.usageError(prepared.error.message);
  const token = context.requireToken();
  if (!token.ok) return token.error;
  const needsMyTasks =
    prepared.value.mySection !== undefined ||
    prepared.value.customFields.length > 0;
  const needsProjectFields = prepared.value.customFields.some(
    (field) => field.field.kind === "gid",
  );
  const dependencies = taskUpdateDependencies(
    context,
    needsMyTasks,
    needsProjectFields,
  );
  if (dryRun) {
    const reader = context.dependencies.taskReader;
    if (!reader) return internalError("Task reader is required");
    return renderTaskPreview(
      invocation.json,
      await previewTaskUpdate(
        token.value,
        prepared.value,
        dependencies,
        reader,
        context.dependencies.taskTargetReader,
      ),
      context.usageError,
    );
  }
  const writer = context.dependencies.taskWriter;
  if (!writer) return internalError("Task writer is required");
  const updated = await executeTaskUpdate(token.value, prepared.value, {
    ...dependencies,
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

const runSelectedUpdate = async (
  context: TaskCommandContext,
  idArg: string,
  options: TaskMutationCliOptions & Readonly<{ parent?: string }>,
): Promise<CommandResult> => {
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
    context.tasks
      .command("update")
      .argument("<id>", "task GID or Asana task URL")
      .usage("[options] <id> <mutation-options>")
      .description("update a task's fields"),
  )
    .option(
      "--project <gid>",
      "add to a project by GID; exclusive with other flags",
    )
    .option(
      "--parent <id>",
      "reparent to a task GID or URL, or null to promote; exclusive with other flags",
    )
    .addHelpText("after", shellTextSafetyHelp("--notes-file <path>"))
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
    errors: [
      ...ASANA_ERROR_CODES,
      "configuration",
      "not_found",
      "outcome_unknown",
    ],
    options: { customField: { repeatable: true } },
    markers: { transmits_local_files: { option: "--notes-file" } },
  });
  command.exitOverride();
  command.configureOutput(context.outputConfiguration);
};

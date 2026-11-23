import { ASANA_ERROR_CODES } from "./errors.ts";
import { resolveConfig } from "../config/index.ts";
import {
  executeTaskCreation,
  prepareTaskCreateWithConfig,
} from "../tasks/index.ts";
import { previewTaskCreation } from "../tasks/mutation-workflow.ts";
import { renderJson, renderTaskCreation } from "../output/index.ts";
import { renderConfigFailure } from "./config-error.ts";
import type { CommandResult } from "./contracts.ts";
import {
  internalError,
  myTasksMutationResolverFor,
  renderTaskWorkflowFailure,
  renderTaskPreview,
  resolveAuthenticatedUserGid,
  taskFileReader,
  taskStdinReader,
  type TaskCommandContext,
  type TaskMutationCliOptions,
} from "./task-command-context.ts";
import { withTaskMutationOptions } from "./task-mutation-options.ts";
import { withCommandCapabilities } from "./capabilities.ts";

const resolveCreationDefaults = async (context: TaskCommandContext) => {
  const configuration = context.dependencies.configuration;
  if (!configuration) return { ok: true as const, value: {} };
  const resolved = await resolveConfig(configuration);
  if (!resolved.ok) return resolved;
  const { defaultAssignee, workspace } = resolved.value.value;
  return {
    ok: true as const,
    value: {
      ...(defaultAssignee === undefined ? {} : { defaultAssignee }),
      ...(workspace?.gid === undefined ? {} : { workspaceGid: workspace.gid }),
    },
  };
};

const taskCreationDependencies = (
  context: TaskCommandContext,
  needsMyTasks: boolean,
) => {
  const dependencies = context.dependencies;
  const myTasksMutationResolver = myTasksMutationResolverFor(
    context,
    needsMyTasks,
  );
  return {
    ...(dependencies.taskWriter ? { writer: dependencies.taskWriter } : {}),
    ...(myTasksMutationResolver ? { myTasksMutationResolver } : {}),
    resolveAuthenticatedUserGid: (token: string) =>
      resolveAuthenticatedUserGid(context, token),
    readFile: taskFileReader(context),
    readStdin: taskStdinReader(context),
  };
};

const runTaskCreate = async (
  context: TaskCommandContext,
  options: TaskMutationCliOptions &
    Readonly<{ parent?: string; project?: string }>,
): Promise<CommandResult> => {
  const invocation = context.beginCommand();
  const { dryRun, customField, ...mutation } = options;
  const prepared = await prepareTaskCreateWithConfig(
    { ...mutation, ...(customField ? { customFields: customField } : {}) },
    () => resolveCreationDefaults(context),
    invocation.fields,
  );
  if (!prepared.ok) {
    return prepared.error.kind === "configuration"
      ? renderConfigFailure(prepared.error)
      : context.usageError(prepared.error.message);
  }
  const token = context.requireToken();
  if (!token.ok) return token.error;
  const needsMyTasks =
    prepared.value.mySection !== undefined ||
    prepared.value.customFields.length > 0;
  const dependencies = taskCreationDependencies(context, needsMyTasks);
  if (dryRun) {
    const reader = context.dependencies.taskTargetReader;
    if (!reader) return internalError("Task target reader is required");
    return renderTaskPreview(
      invocation.json,
      await previewTaskCreation(
        token.value,
        prepared.value,
        dependencies,
        reader,
      ),
      context.usageError,
    );
  }
  const creator = context.dependencies.taskCreator;
  if (!creator) return internalError("Task creator is required");
  const created = await executeTaskCreation(token.value, prepared.value, {
    ...dependencies,
    creator,
  });
  if (!created.ok) {
    return renderTaskWorkflowFailure(created.error, context.usageError);
  }
  return {
    stdout: invocation.json
      ? renderJson(created.value.task, { stages: created.value.stages })
      : renderTaskCreation(created.value.task, created.value.stages),
    stderr: "",
    exitCode: created.value.complete ? 0 : 1,
  };
};

export const registerTaskCreateCommand = (
  context: TaskCommandContext,
): void => {
  const command = withTaskMutationOptions(
    context.tasks
      .command("create")
      .usage(
        "--name <name> [options] (--parent <id> | --project <gid> | --section <gid> | --my-section <alias>)",
      )
      .description("create a task or subtask")
      .option("--parent <id>", "parent task GID or URL")
      .option("--project <gid>", "destination project GID"),
  ).action(
    async (
      options: TaskMutationCliOptions &
        Readonly<{ parent?: string; project?: string }>,
    ) => context.complete(await runTaskCreate(context, options)),
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
    partial: true,
    options: { customField: { repeatable: true } },
    markers: { transmits_local_files: { option: "--notes-file" } },
  });
  command.exitOverride();
  command.configureOutput(context.outputConfiguration);
};

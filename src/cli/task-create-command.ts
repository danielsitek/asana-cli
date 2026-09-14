import { resolveConfig } from "../config/index.ts";
import {
  executeTaskCreation,
  prepareTaskCreateWithConfig,
} from "../tasks/index.ts";
import { renderJson, renderTaskCreation } from "../output/index.ts";
import { renderConfigFailure } from "./config-error.ts";
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
    creator: dependencies.taskCreator!,
    ...(dependencies.taskWriter ? { writer: dependencies.taskWriter } : {}),
    ...(myTasksMutationResolver ? { myTasksMutationResolver } : {}),
    resolveAuthenticatedUserGid: (token: string) =>
      resolveAuthenticatedUserGid(context, token),
    readFile: taskFileReader(context),
    readStdin: taskStdinReader(context),
  };
};

const prepareTaskCreation = async (
  context: TaskCommandContext,
  options: TaskMutationCliOptions &
    Readonly<{ parent?: string; project?: string }>,
  invocation: TaskInvocation,
) =>
  prepareTaskCreateWithConfig(
    {
      ...options,
      ...(options.customField ? { customFields: options.customField } : {}),
    },
    () => resolveCreationDefaults(context),
    invocation.fields,
  );

const runTaskCreate = async (
  context: TaskCommandContext,
  options: TaskMutationCliOptions &
    Readonly<{ parent?: string; project?: string }>,
): Promise<Execution> => {
  const invocation = context.beginCommand();
  const prepared = await prepareTaskCreation(context, options, invocation);
  if (!prepared.ok) {
    return prepared.error.kind === "configuration"
      ? renderConfigFailure(prepared.error)
      : context.usageError(prepared.error.message);
  }
  const token = context.requireToken();
  if (!token.ok) return token.error;
  if (!context.dependencies.taskCreator) {
    return internalError("Task creator is required");
  }
  const needsMyTasks =
    prepared.value.mySection !== undefined ||
    prepared.value.customFields.length > 0;
  const created = await executeTaskCreation(
    token.value,
    prepared.value,
    taskCreationDependencies(context, needsMyTasks),
  );
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
      .description("create a task or subtask")
      .option("--parent <id>", "parent task GID or URL")
      .option("--project <gid>", "destination project GID"),
  ).action(
    async (
      options: TaskMutationCliOptions &
        Readonly<{ parent?: string; project?: string }>,
    ) => context.complete(await runTaskCreate(context, options)),
  );
  command.exitOverride();
  command.configureOutput(context.outputConfiguration);
};

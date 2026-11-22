import { ASANA_ERROR_CODES } from "./errors.ts";
import {
  executeTaskListRead,
  prepareTaskListRead,
  type TaskListOptions,
} from "../tasks/index.ts";
import { renderJson, renderTaskList } from "../output/index.ts";
import type { CommandResult } from "./contracts.ts";
import { renderListContinuation } from "./list-pagination.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import {
  internalError,
  mySectionResolverFor,
  renderTaskWorkflowFailure,
  resolveAuthenticatedUserGid,
  type TaskCommandContext,
} from "./task-command-context.ts";

const runTaskList = async (
  context: TaskCommandContext,
  options: TaskListOptions,
): Promise<CommandResult> => {
  const invocation = context.beginCommand();
  const prepared = prepareTaskListRead(options, invocation.fields);
  if (!prepared.ok) return context.usageError(prepared.error.message);
  const token = context.requireToken();
  if (!token.ok) return token.error;
  const reader = context.dependencies.taskListReader;
  if (!reader) return internalError("Task list reader is required");
  const mySectionResolver = mySectionResolverFor(
    context,
    prepared.value.source.kind === "my_section",
  );
  const listed = await executeTaskListRead(token.value, prepared.value, {
    reader,
    ...(mySectionResolver ? { mySectionResolver } : {}),
    resolveAuthenticatedUserGid: (authenticatedToken) =>
      resolveAuthenticatedUserGid(context, authenticatedToken),
  });
  if (!listed.ok) {
    return renderTaskWorkflowFailure(listed.error, context.usageError);
  }
  return {
    stdout: invocation.json
      ? renderJson(listed.value.tasks, listed.value.meta)
      : renderTaskList(listed.value.tasks, prepared.value.outputFields),
    stderr: invocation.json
      ? ""
      : renderListContinuation(
          listed.value.meta,
          ["tasks", "list"],
          options,
          invocation.fields,
        ),
    exitCode: 0,
  };
};

export const registerTaskListCommand = (context: TaskCommandContext): void => {
  const command = context.tasks
    .command("list")
    .usage(
      "(--my-section <alias> | --section <gid> | --project <gid> | --parent <id>) [options]",
    )
    .description(
      "list tasks from a My Tasks section, section, project, or parent task",
    )
    .option("--my-section <alias>", "list a My Tasks section by @alias")
    .option("--section <gid>", "list a section by GID")
    .option("--project <gid>", "list a project by GID")
    .option("--parent <id>", "list a task's direct subtasks by GID or URL")
    .option("--assignee <value>", "filter by me or a user GID")
    .option("--completed <boolean>", "filter by completed true or false")
    .option("--max <n>", "cap tasks scanned; alone does not return all")
    .option("--offset <token>", "resume from an Asana offset")
    .option("--all", "return all tasks within the scan cap; requires --max")
    .action(async (options: TaskListOptions) => {
      context.complete(await runTaskList(context, options));
    });
  withCommandCapabilities(command, {
    operation: "read",
    requirements: {
      authentication: "required",
      configuration: "conditional",
    },
    errors: [...ASANA_ERROR_CODES, "configuration", "not_found"],
  });
  command.exitOverride();
  command.configureOutput(context.outputConfiguration);
};

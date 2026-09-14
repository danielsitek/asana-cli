import { executeTaskListRead, prepareTaskListRead } from "../tasks/index.ts";
import {
  renderJson,
  renderTaskList,
  renderTaskListScanWarning,
} from "../output/index.ts";
import type { Execution } from "./contracts.ts";
import {
  internalError,
  mySectionResolverFor,
  renderTaskWorkflowFailure,
  resolveAuthenticatedUserGid,
  type TaskCommandContext,
  type TaskInvocation,
} from "./task-command-context.ts";

type TaskListOptions = Readonly<{
  mySection?: string;
  section?: string;
  project?: string;
  parent?: string;
  assignee?: string;
  completed?: string;
  max?: string;
  all?: boolean;
}>;

const prepareList = (options: TaskListOptions, invocation: TaskInvocation) =>
  prepareTaskListRead(
    {
      ...(options.mySection === undefined
        ? {}
        : { mySection: options.mySection }),
      ...(options.section === undefined ? {} : { section: options.section }),
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.parent === undefined ? {} : { parent: options.parent }),
      ...(options.assignee === undefined ? {} : { assignee: options.assignee }),
      ...(options.completed === undefined
        ? {}
        : { completed: options.completed }),
      ...(options.max === undefined ? {} : { max: options.max }),
      ...(options.all === undefined ? {} : { all: options.all }),
    },
    invocation.fields,
  );

const runTaskList = async (
  context: TaskCommandContext,
  options: TaskListOptions,
): Promise<Execution> => {
  const invocation = context.beginCommand();
  const prepared = prepareList(options, invocation);
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
      : renderTaskListScanWarning(listed.value.meta.scan_truncated),
    exitCode: 0,
  };
};

export const registerTaskListCommand = (context: TaskCommandContext): void => {
  const command = context.tasks
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
    .action(async (options: TaskListOptions) => {
      context.complete(await runTaskList(context, options));
    });
  command.exitOverride();
  command.configureOutput(context.outputConfiguration);
};

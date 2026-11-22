import { ASANA_ERROR_CODES, asanaFailure, commandError } from "./errors.ts";
import {
  executeTaskCommentsRead,
  prepareTaskCommentsRead,
} from "../comments/index.ts";
import { renderCommentList, renderJson } from "../output/index.ts";
import type { CommandResult } from "./contracts.ts";
import { renderListContinuation } from "./list-pagination.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import {
  internalError,
  type TaskCommandContext,
  type TaskInvocation,
} from "./task-command-context.ts";

type TaskCommentsOptions = Readonly<{
  max?: string;
  offset?: string;
  all?: boolean;
  latest?: string;
}>;

const prepareComments = (
  idArg: string,
  options: TaskCommentsOptions,
  invocation: TaskInvocation,
) =>
  prepareTaskCommentsRead(idArg, {
    ...(invocation.fields === undefined ? {} : { fields: invocation.fields }),
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.offset === undefined ? {} : { offset: options.offset }),
    ...(options.all === undefined ? {} : { all: options.all }),
    ...(options.latest === undefined ? {} : { latest: options.latest }),
  });

const scanLimitError = (message: string): CommandResult =>
  commandError("scan_limit", message);

const runTaskComments = async (
  context: TaskCommandContext,
  idArg: string,
  options: TaskCommentsOptions,
): Promise<CommandResult> => {
  const invocation = context.beginCommand();
  const prepared = prepareComments(idArg, options, invocation);
  if (!prepared.ok) return context.usageError(prepared.error.message);
  const token = context.requireToken();
  if (!token.ok) return token.error;
  const reader = context.dependencies.commentReader;
  if (!reader) return internalError("Comment reader is required");
  const read = await executeTaskCommentsRead(token.value, prepared.value, {
    reader,
  });
  if (!read.ok) {
    return read.error.kind === "scan_limit"
      ? scanLimitError(read.error.message)
      : asanaFailure(read.error);
  }
  return {
    stdout: invocation.json
      ? renderJson(read.value.comments, read.value.meta)
      : renderCommentList(read.value.comments, prepared.value.outputFields),
    stderr: invocation.json
      ? ""
      : renderListContinuation(
          read.value.meta,
          ["tasks", "comments", idArg],
          options,
          invocation.fields,
        ),
    exitCode: 0,
  };
};

export const registerTaskCommentsCommand = (
  context: TaskCommandContext,
): void => {
  const command = context.tasks
    .command("comments")
    .argument("<id>", "task GID or Asana task URL")
    .description("read task comments")
    .option("--max <n>", "cap stories scanned; alone does not return all")
    .option("--offset <token>", "resume from an Asana offset")
    .option("--all", "return all comments within the scan cap; requires --max")
    .option(
      "--latest <n>",
      "return the newest N comments after exhausting the source; requires --max",
    )
    .action(async (idArg: string, options: TaskCommentsOptions) => {
      context.complete(await runTaskComments(context, idArg, options));
    });
  withCommandCapabilities(command, {
    operation: "read",
    markers: { paginated: true },
    requirements: { authentication: "required", configuration: "never" },
    errors: [...ASANA_ERROR_CODES, "not_found", "scan_limit"],
  });
  command.exitOverride();
  command.configureOutput(context.outputConfiguration);
};

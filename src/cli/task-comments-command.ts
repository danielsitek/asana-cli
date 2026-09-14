import {
  executeTaskCommentsRead,
  prepareTaskCommentsRead,
} from "../comments/index.ts";
import {
  renderCommentList,
  renderCommentScanWarning,
  renderError,
  renderJson,
} from "../output/index.ts";
import type { Execution } from "./contracts.ts";
import {
  internalError,
  renderTaskReadFailure,
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

const scanLimitError = (message: string): Execution => ({
  stdout: "",
  stderr: renderError({ code: "scan_limit", message }),
  exitCode: 5,
});

const runTaskComments = async (
  context: TaskCommandContext,
  idArg: string,
  options: TaskCommentsOptions,
): Promise<Execution> => {
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
      : renderTaskReadFailure(read.error.kind);
  }
  return {
    stdout: invocation.json
      ? renderJson(read.value.comments, read.value.meta)
      : renderCommentList(read.value.comments, prepared.value.outputFields),
    stderr: invocation.json
      ? ""
      : renderCommentScanWarning(read.value.meta.scan_truncated),
    exitCode: 0,
  };
};

export const registerTaskCommentsCommand = (
  context: TaskCommandContext,
): void => {
  const command = context.tasks
    .command("comments <id>")
    .description("read task comments")
    .option("--max <n>", "cap stories scanned")
    .option("--offset <token>", "start from an Asana offset")
    .option("--all", "return all comments within the scan cap")
    .option(
      "--latest <n>",
      "return the newest N comments after exhausting the source within --max",
    )
    .action(async (idArg: string, options: TaskCommentsOptions) => {
      context.complete(await runTaskComments(context, idArg, options));
    });
  command.exitOverride();
  command.configureOutput(context.outputConfiguration);
};

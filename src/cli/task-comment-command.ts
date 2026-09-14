import {
  executeTaskCommentCreate,
  prepareTaskCommentCreate,
} from "../comments/index.ts";
import { renderCommentDetail, renderJson } from "../output/index.ts";
import type { Execution } from "./contracts.ts";
import {
  internalError,
  renderTaskReadFailure,
  taskFileReader,
  taskStdinReader,
  type TaskCommandContext,
  type TaskInvocation,
} from "./task-command-context.ts";

type TaskCommentOptions = Readonly<{ file?: string }>;

const prepareComment = (
  idArg: string,
  textArg: string | undefined,
  options: TaskCommentOptions,
  invocation: TaskInvocation,
) =>
  prepareTaskCommentCreate(idArg, {
    ...(invocation.fields === undefined ? {} : { fields: invocation.fields }),
    ...(textArg === undefined ? {} : { text: textArg }),
    ...(options.file === undefined ? {} : { file: options.file }),
  });

const runTaskComment = async (
  context: TaskCommandContext,
  idArg: string,
  textArg: string | undefined,
  options: TaskCommentOptions,
): Promise<Execution> => {
  const invocation = context.beginCommand();
  const prepared = prepareComment(idArg, textArg, options, invocation);
  if (!prepared.ok) return context.usageError(prepared.error.message);
  const token = context.requireToken();
  if (!token.ok) return token.error;
  const writer = context.dependencies.commentWriter;
  if (!writer) return internalError("Comment writer is required");
  const created = await executeTaskCommentCreate(token.value, prepared.value, {
    writer,
    readFile: taskFileReader(context),
    readStdin: taskStdinReader(context),
  });
  if (!created.ok) {
    return created.error.kind === "invalid_usage"
      ? context.usageError(created.error.message)
      : renderTaskReadFailure(created.error.kind);
  }
  return {
    stdout: invocation.json
      ? renderJson(created.value)
      : renderCommentDetail(created.value),
    stderr: "",
    exitCode: 0,
  };
};

export const registerTaskCommentCommand = (
  context: TaskCommandContext,
): void => {
  const command = context.tasks
    .command("comment <id> [text]")
    .description("create a task comment")
    .option("--file <path>", "read comment text from a file or stdin with -")
    .action(
      async (
        idArg: string,
        textArg: string | undefined,
        options: TaskCommentOptions,
      ) => {
        context.complete(
          await runTaskComment(context, idArg, textArg, options),
        );
      },
    );
  command.exitOverride();
  command.configureOutput(context.outputConfiguration);
};

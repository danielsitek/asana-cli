import { ASANA_ERROR_CODES, asanaFailure } from "./errors.ts";
import {
  executeTaskCommentCreate,
  prepareTaskCommentCreate,
} from "../comments/index.ts";
import { renderCommentDetail, renderJson } from "../output/index.ts";
import type { CommandResult } from "./contracts.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import { shellTextSafetyHelp } from "./shell-text-help.ts";
import {
  internalError,
  taskFileReader,
  taskStdinReader,
  type TaskCommandContext,
  type TaskInvocation,
} from "./task-command-context.ts";

type TaskCommentOptions = Readonly<{ file?: string; replyTo?: string }>;

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
    ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
  });

const runTaskComment = async (
  context: TaskCommandContext,
  idArg: string,
  textArg: string | undefined,
  options: TaskCommentOptions,
): Promise<CommandResult> => {
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
      : asanaFailure(created.error);
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
    .command("comment")
    .argument("<id>", "task GID or Asana task URL")
    .argument("[text]", "comment text")
    .usage("[options] <id> (<text> | --file <path>)")
    .description("create a task comment")
    .option("--file <path>", "read comment text from a file or stdin with -")
    .option(
      "--reply-to <story-gid>",
      "reply to a top-level comment on this task",
    )
    .addHelpText("after", shellTextSafetyHelp("--file <path>"))
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
  withCommandCapabilities(command, {
    operation: "write",
    requirements: { authentication: "required", configuration: "never" },
    errors: [...ASANA_ERROR_CODES, "not_found", "outcome_unknown"],
    markers: { transmits_local_files: { option: "--file" } },
  });
  command.exitOverride();
  command.configureOutput(context.outputConfiguration);
};

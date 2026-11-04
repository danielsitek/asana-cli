import {
  executeAttachmentUpload,
  prepareAttachmentUpload,
} from "../attachments/upload.ts";
import { renderJson, renderTaskDetail } from "../output/index.ts";
import type { Execution } from "./contracts.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import {
  internalError,
  renderTaskReadFailure,
  type TaskCommandContext,
} from "./task-command-context.ts";

type Options = Readonly<{
  file: string;
  name?: string;
  inline?: string | boolean;
}>;

const runTaskAttach = async (
  context: TaskCommandContext,
  id: string,
  options: Options,
): Promise<Execution> => {
  const invocation = context.beginCommand();
  const prepared = await prepareAttachmentUpload(id, options);
  if (!prepared.ok) {
    return prepared.error.kind === "invalid_usage"
      ? context.usageError(prepared.error.message)
      : internalError("Attachment preparation failed");
  }
  const token = context.requireToken();
  if (!token.ok) return token.error;
  const writer = context.dependencies.attachmentWriter;
  const reader = context.dependencies.taskReader;
  if (!writer) return internalError("Attachment writer is required");
  const attached = await executeAttachmentUpload(
    token.value,
    prepared.value,
    reader,
    writer,
  );
  if (!attached.ok) {
    if (attached.error.kind === "invalid_usage")
      return context.usageError(attached.error.message);
    if (attached.error.kind === "internal_error")
      return internalError(attached.error.message);
    if (attached.error.kind !== "partial")
      return renderTaskReadFailure(attached.error.kind);
    return {
      stdout: `${JSON.stringify({
        completed: { upload: attached.error.uploaded },
        failed: {
          stage: "inline",
          code: attached.error.failed.kind,
          message: "Failed to update task html_notes",
        },
      })}\n`,
      stderr: "",
      exitCode: 1,
    };
  }
  return {
    stdout: invocation.json
      ? renderJson(attached.value)
      : renderTaskDetail(attached.value),
    stderr: "",
    exitCode: 0,
  };
};

export const registerTaskAttachCommand = (
  context: TaskCommandContext,
): void => {
  const command = context.tasks
    .command("attach <id>")
    .description(
      "upload a file to a task and optionally insert an inline image",
    )
    .requiredOption("--file <path>", "local file to upload")
    .option("--name <name>", "attachment filename")
    .option(
      "--inline [position]",
      "insert an image into html_notes (append or prepend)",
    )
    .action(async (id: string, options: Options) =>
      context.complete(await runTaskAttach(context, id, options)),
    );
  withCommandCapabilities(command, {
    operation: "write",
    requirements: { authentication: "required", configuration: "never" },
    exitCodes: [0, 1, 2, 3, 4, 5, 6],
  });
  command.exitOverride();
  command.configureOutput(context.outputConfiguration);
};

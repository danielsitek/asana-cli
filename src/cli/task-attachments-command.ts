import {
  executeAttachmentList,
  prepareAttachmentList,
} from "../attachments/index.ts";
import { renderJson, renderTaskList } from "../output/index.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import {
  internalError,
  renderTaskReadFailure,
  type TaskCommandContext,
} from "./task-command-context.ts";

type Options = Readonly<{ max?: string; all?: boolean }>;

export const registerTaskAttachmentsCommand = (
  context: TaskCommandContext,
): void => {
  const command = context.tasks
    .command("attachments <id>")
    .description("list attachments on a task, including inline images")
    .option("--max <n>", "cap attachments scanned; alone does not return all")
    .option(
      "--all",
      "return all attachments within the scan cap; requires --max",
    )
    .action(async (id: string, options: Options) => {
      const invocation = context.beginCommand();
      const prepared = prepareAttachmentList(id, {
        ...(invocation.fields === undefined
          ? {}
          : { fields: invocation.fields }),
        ...(options.max === undefined ? {} : { max: options.max }),
        ...(options.all === undefined ? {} : { all: options.all }),
      });
      if (!prepared.ok)
        return context.complete(context.usageError(prepared.error.message));
      const token = context.requireToken();
      if (!token.ok) return context.complete(token.error);
      const reader = context.dependencies.attachmentReader;
      if (!reader)
        return context.complete(internalError("Attachment reader is required"));
      const listed = await executeAttachmentList(
        token.value,
        prepared.value,
        reader,
      );
      if (!listed.ok)
        return context.complete(renderTaskReadFailure(listed.error.kind));
      context.complete({
        stdout: invocation.json
          ? renderJson(listed.value.attachments, listed.value.meta)
          : renderTaskList(listed.value.attachments, prepared.value.fields),
        stderr:
          invocation.json || !listed.value.meta.scan_truncated
            ? ""
            : "Attachment scan truncated; increase --max to read more.\n",
        exitCode: 0,
      });
    });
  withCommandCapabilities(command, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    exitCodes: [0, 2, 3, 4, 5, 6],
  });
  command.exitOverride();
  command.configureOutput(context.outputConfiguration);
};

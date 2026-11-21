import { ASANA_ERROR_CODES, asanaFailure } from "./errors.ts";
import type { ListOptions } from "../pagination/index.ts";
import {
  executeAttachmentList,
  prepareAttachmentList,
} from "../attachments/index.ts";
import { renderJson, renderTaskList } from "../output/index.ts";
import { renderListContinuation } from "./list-pagination.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import {
  internalError,
  type TaskCommandContext,
} from "./task-command-context.ts";

export const registerTaskAttachmentsCommand = (
  context: TaskCommandContext,
): void => {
  const command = context.tasks
    .command("attachments <id>")
    .description("list attachments on a task, including inline images")
    .option("--max <n>", "cap attachments scanned; alone does not return all")
    .option("--offset <token>", "resume from an Asana offset")
    .option(
      "--all",
      "return all attachments within the scan cap; requires --max",
    )
    .action(async (id: string, options: ListOptions) => {
      const invocation = context.beginCommand();
      const prepared = prepareAttachmentList(id, {
        ...(invocation.fields === undefined
          ? {}
          : { fields: invocation.fields }),
        ...options,
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
      if (!listed.ok) return context.complete(asanaFailure(listed.error));
      context.complete({
        stdout: invocation.json
          ? renderJson(listed.value.attachments, listed.value.meta)
          : renderTaskList(listed.value.attachments, prepared.value.fields),
        stderr: invocation.json
          ? ""
          : renderListContinuation(
              listed.value.meta,
              ["tasks", "attachments", id],
              options,
              invocation.fields,
            ),
        exitCode: 0,
      });
    });
  withCommandCapabilities(command, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    errors: [...ASANA_ERROR_CODES, "not_found"],
  });
  command.exitOverride();
  command.configureOutput(context.outputConfiguration);
};

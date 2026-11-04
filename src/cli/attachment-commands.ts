import type { Command, OutputConfiguration } from "commander";

import { downloadAttachment } from "../attachments/download.ts";
import { renderJson } from "../output/index.ts";
import type { Result } from "../shared/result.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import type { ExecuteDependencies, Execution } from "./contracts.ts";
import {
  internalError,
  renderTaskReadFailure,
} from "./task-command-context.ts";

export const registerAttachmentCommands = (
  context: Readonly<{
    program: Command;
    dependencies: ExecuteDependencies;
    beginCommand: () => Readonly<{ json: boolean }>;
    complete: (execution: Execution) => void;
    requireToken: () => Result<string, Execution>;
    usageError: (message: string) => Execution;
    outputConfiguration: OutputConfiguration;
  }>,
): void => {
  const attachments = context.program
    .command("attachments")
    .description("download Asana attachments");
  withCommandCapabilities(attachments, {
    operation: "write",
    requirements: { authentication: "required", configuration: "never" },
    exitCodes: [0, 2, 3, 4, 5, 6],
  });
  attachments.exitOverride();
  attachments.configureOutput(context.outputConfiguration);

  const download = attachments
    .command("download <attachment-gid>")
    .description("save an attachment to a file or directory")
    .requiredOption("--out <path>", "output file or existing directory")
    .option("--force", "replace an existing file")
    .action(
      async (
        gid: string,
        options: Readonly<{ out: string; force?: boolean }>,
      ) => {
        const invocation = context.beginCommand();
        const token = context.requireToken();
        if (!token.ok) return context.complete(token.error);
        const reader = context.dependencies.attachmentReader;
        if (!reader)
          return context.complete(
            internalError("Attachment reader is required"),
          );
        const result = await downloadAttachment(
          token.value,
          gid,
          options.out,
          options.force === true,
          reader,
          context.dependencies.fetchAttachment,
        );
        if (!result.ok) {
          if (result.error.kind === "invalid_usage")
            return context.complete(context.usageError(result.error.message));
          if (result.error.kind === "internal_error")
            return context.complete(internalError(result.error.message));
          return context.complete(renderTaskReadFailure(result.error.kind));
        }
        context.complete({
          stdout: invocation.json
            ? renderJson(result.value)
            : `Downloaded ${result.value.gid} to ${result.value.path} (${result.value.bytes} bytes)\n`,
          stderr: "",
          exitCode: 0,
        });
      },
    );
  withCommandCapabilities(download, {
    operation: "write",
    requirements: { authentication: "required", configuration: "never" },
    exitCodes: [0, 2, 3, 4, 5, 6],
  });
  download.exitOverride();
  download.configureOutput(context.outputConfiguration);
};

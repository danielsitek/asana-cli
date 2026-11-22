import { ASANA_ERROR_CODES, asanaFailure } from "./errors.ts";
import type { Command, OutputConfiguration } from "commander";

import { downloadAttachment } from "../attachments/download.ts";
import { renderJson } from "../output/index.ts";
import type { Result } from "../shared/result.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import type { ExecuteDependencies, CommandResult } from "./contracts.ts";
import { internalError } from "./task-command-context.ts";

export const registerAttachmentCommands = (
  context: Readonly<{
    program: Command;
    dependencies: ExecuteDependencies;
    beginCommand: () => Readonly<{ json: boolean }>;
    complete: (execution: CommandResult) => void;
    requireToken: () => Result<string, CommandResult>;
    usageError: (message: string) => CommandResult;
    outputConfiguration: OutputConfiguration;
  }>,
): void => {
  const attachments = context.program
    .command("attachments")
    .description("download Asana attachments");
  withCommandCapabilities(attachments, {
    operation: "write",
    requirements: { authentication: "required", configuration: "never" },
  });
  attachments.exitOverride();
  attachments.configureOutput(context.outputConfiguration);

  const download = attachments
    .command("download <attachment-gid>")
    .usage("--out <path> [options] <attachment-gid>")
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
          return context.complete(asanaFailure(result.error));
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
    errors: [...ASANA_ERROR_CODES, "not_found"],
  });
  download.exitOverride();
  download.configureOutput(context.outputConfiguration);
};

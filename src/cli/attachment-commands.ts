import { ASANA_ERROR_CODES, asanaFailure, commandError } from "./errors.ts";
import type { Command, OutputConfiguration } from "commander";

import {
  downloadAttachment,
  prepareAttachmentDownload,
  type AttachmentDownloadError,
} from "../attachments/download.ts";
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

  const downloadFailure = (error: AttachmentDownloadError) =>
    error.kind === "invalid_usage"
      ? context.usageError(error.message)
      : error.kind === "already_exists"
        ? commandError(error.kind, error.message)
        : asanaFailure(error, "Attachment not found");

  const download = attachments
    .command("download")
    .argument("<attachment-gid>", "attachment GID")
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
        const prepared = await prepareAttachmentDownload(
          gid,
          options.out,
          options.force === true,
        );
        if (!prepared.ok)
          return context.complete(downloadFailure(prepared.error));
        const token = context.requireToken();
        if (!token.ok) return context.complete(token.error);
        const reader = context.dependencies.attachmentReader;
        if (!reader)
          return context.complete(
            internalError("Attachment reader is required"),
          );
        const result = await downloadAttachment(
          token.value,
          prepared.value,
          reader,
          context.dependencies.fetchAttachment,
        );
        if (!result.ok) return context.complete(downloadFailure(result.error));
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
    errors: [...ASANA_ERROR_CODES, "not_found", "already_exists"],
    markers: { overwrites_local_files: { option: "--force" } },
  });
  download.exitOverride();
  download.configureOutput(context.outputConfiguration);
};

import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import { err, ok, type Result } from "../shared/result.ts";
import {
  parseTaskId,
  type TaskGateway,
  type TaskReadError,
} from "../tasks/index.ts";

export const MAX_ATTACHMENT_BYTES = 100_000_000;

export type UploadedAttachment = Readonly<{
  gid: string;
  name: string;
  size: number;
  content_type: string;
}>;

export interface AttachmentWriteGateway {
  uploadTaskAttachment(
    token: string,
    taskId: string,
    file: Readonly<{ name: string; bytes: Uint8Array; contentType: string }>,
  ): Promise<Result<UploadedAttachment, TaskReadError>>;
  setTaskHtmlNotes(
    token: string,
    taskId: string,
    htmlNotes: string,
  ): Promise<Result<void, TaskReadError>>;
}

export type AttachmentUploadError =
  | TaskReadError
  | Readonly<{ kind: "invalid_usage" | "internal_error"; message: string }>
  | Readonly<{
      kind: "partial";
      uploaded: UploadedAttachment;
      failed: TaskReadError;
    }>;

export type PreparedUpload = Readonly<{
  taskId: string;
  name: string;
  bytes: Uint8Array;
  contentType: string;
  inline?: "append" | "prepend";
}>;

const inlineMode = (
  value: string | boolean | undefined,
): Result<"append" | "prepend" | undefined, AttachmentUploadError> =>
  value === undefined || value === false
    ? ok(undefined)
    : value === true || value === "append"
      ? ok("append")
      : value === "prepend"
        ? ok("prepend")
        : err({
            kind: "invalid_usage",
            message: "--inline must be append or prepend",
          });

export const prepareAttachmentUpload = async (
  taskIdInput: string,
  options: Readonly<{ file: string; name?: string; inline?: string | boolean }>,
): Promise<Result<PreparedUpload, AttachmentUploadError>> => {
  const task = parseTaskId(taskIdInput);
  if (!task.ok) return err({ kind: "invalid_usage", message: task.error });
  const inline = inlineMode(options.inline);
  if (!inline.ok) return inline;
  const name = options.name ?? basename(options.file);
  if (
    name.trim() === "" ||
    name === "." ||
    name === ".." ||
    /[/\\]/.test(name)
  ) {
    return err({ kind: "invalid_usage", message: "Invalid attachment name" });
  }
  let bytes: Uint8Array;
  try {
    const info = await stat(options.file);
    if (!info.isFile())
      return err({
        kind: "invalid_usage",
        message: "Attachment path must be a readable file",
      });
    if (info.size > MAX_ATTACHMENT_BYTES)
      return err({
        kind: "invalid_usage",
        message: "Attachment exceeds Asana's 100 MB upload limit",
      });
    bytes = await readFile(options.file);
  } catch {
    return err({
      kind: "invalid_usage",
      message: "Attachment path must be a readable file",
    });
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return err({
      kind: "invalid_usage",
      message: "Attachment exceeds Asana's 100 MB upload limit",
    });
  }
  const contentType = Bun.file(options.file).type;
  if (inline.value && !contentType.startsWith("image/")) {
    return err({
      kind: "invalid_usage",
      message: "--inline requires an image file",
    });
  }
  return ok({
    taskId: task.value,
    name,
    bytes,
    contentType,
    ...(inline.value ? { inline: inline.value } : {}),
  });
};

export const insertInlineImage = (
  htmlNotes: string,
  attachmentGid: string,
  position: "append" | "prepend",
): Result<string, TaskReadError> => {
  const html = htmlNotes === "" ? "<body></body>" : htmlNotes;
  const open = /^<body(?:\s[^>]*)?>/.exec(html);
  const close = /<\/body>$/.exec(html);
  if (!open || !close) {
    return err({
      kind: "invalid_response",
      message: "Task html_notes has no body wrapper",
    });
  }
  const insertion = position === "prepend" ? open[0].length : close.index;
  const image = `<img data-asana-gid="${attachmentGid}">`;
  return ok(html.slice(0, insertion) + image + html.slice(insertion));
};

export const executeAttachmentUpload = async (
  token: string,
  prepared: PreparedUpload,
  reader: TaskGateway | undefined,
  writer: AttachmentWriteGateway,
): Promise<Result<UploadedAttachment, AttachmentUploadError>> => {
  let htmlNotes: string | undefined;
  if (prepared.inline) {
    if (!reader)
      return err({
        kind: "internal_error",
        message: "Task reader is required for inline uploads",
      });
    const task = await reader.getTask(token, prepared.taskId, ["html_notes"]);
    if (!task.ok) return task;
    if (typeof task.value.html_notes !== "string") {
      return err({
        kind: "invalid_response",
        message: "Task html_notes is missing",
      });
    }
    htmlNotes = task.value.html_notes;
    const checked = insertInlineImage(htmlNotes, "1", prepared.inline);
    if (!checked.ok) return checked;
  }
  const uploaded = await writer.uploadTaskAttachment(
    token,
    prepared.taskId,
    prepared,
  );
  if (!uploaded.ok) return uploaded;
  if (!prepared.inline || htmlNotes === undefined) return uploaded;
  const updated = insertInlineImage(
    htmlNotes,
    uploaded.value.gid,
    prepared.inline,
  );
  if (!updated.ok)
    return err({
      kind: "partial",
      uploaded: uploaded.value,
      failed: { kind: "invalid_response", message: updated.error.message },
    });
  const written = await writer.setTaskHtmlNotes(
    token,
    prepared.taskId,
    updated.value,
  );
  return written.ok
    ? uploaded
    : err({ kind: "partial", uploaded: uploaded.value, failed: written.error });
};

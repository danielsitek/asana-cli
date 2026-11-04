import { z } from "zod";

import type {
  AttachmentWriteGateway,
  UploadedAttachment,
} from "../attachments/upload.ts";
import type { TaskReadError } from "../tasks/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import {
  AsanaHttpTransport,
  type HttpTransportOptions,
} from "./http-transport.ts";

const uploadResponseSchema = z.object({
  data: z
    .object({ gid: z.string().regex(/^\d+$/), name: z.string() })
    .passthrough(),
});

const mapWriteError = (error: TaskReadError): TaskReadError =>
  error.kind === "api" && error.status === 404
    ? { kind: "not_found", status: 404, message: "Task not found" }
    : error;

export class AsanaAttachmentWriter implements AttachmentWriteGateway {
  readonly #transport: AsanaHttpTransport;

  constructor(options: HttpTransportOptions = {}) {
    this.#transport = new AsanaHttpTransport({
      requestTimeoutMs: 120_000,
      ...options,
    });
  }

  async uploadTaskAttachment(
    token: string,
    taskId: string,
    file: Readonly<{ name: string; bytes: Uint8Array; contentType: string }>,
  ): Promise<Result<UploadedAttachment, TaskReadError>> {
    const form = new FormData();
    form.set("parent", taskId);
    const filename = /[^\x20-\x7e]/.test(file.name)
      ? encodeURIComponent(file.name)
      : file.name;
    form.set(
      "file",
      new Blob([Uint8Array.from(file.bytes)], { type: file.contentType }),
      filename,
    );
    const result = await this.#transport.request(
      token,
      "attachments",
      {
        method: "POST",
        searchParams: { opt_fields: "gid,name,size" },
        body: form,
      },
      uploadResponseSchema,
    );
    if (!result.ok) return err(mapWriteError(result.error));
    return ok({
      gid: result.value.data.gid,
      name: result.value.data.name,
      size: file.bytes.byteLength,
      content_type: file.contentType,
    });
  }

  async setTaskHtmlNotes(
    token: string,
    taskId: string,
    htmlNotes: string,
  ): Promise<Result<void, TaskReadError>> {
    const result = await this.#transport.request(
      token,
      `tasks/${taskId}`,
      {
        method: "PUT",
        body: { data: { html_notes: htmlNotes } },
      },
      z.object({
        data: z.object({ gid: z.string().regex(/^\d+$/) }).passthrough(),
      }),
    );
    return result.ok ? ok(undefined) : err(mapWriteError(result.error));
  }
}

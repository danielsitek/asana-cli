import { open, rename, link, unlink, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { err, ok, type Result } from "../shared/result.ts";
import type { TaskReadError } from "../tasks/index.ts";
import type { AttachmentGateway } from "./index.ts";

export type AttachmentDownload = Readonly<{
  gid: string;
  path: string;
  bytes: number;
  content_type: string | null;
}>;

export type AttachmentDownloadError =
  | TaskReadError
  | Readonly<{
      kind: "invalid_usage" | "internal_error";
      message: string;
    }>;

export type FetchAttachment = (
  url: URL,
  init?: RequestInit,
) => Promise<Response>;

const safeName = (name: string): string => {
  const sanitized = [...basename(name.replaceAll("\\", "/"))]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? "_" : character;
    })
    .join("");
  return sanitized === "." || sanitized === ".." || sanitized === ""
    ? "attachment"
    : sanitized;
};

const downloadUrl = (
  value: string | null,
): Result<URL, AttachmentDownloadError> => {
  if (value === null)
    return err({
      kind: "api",
      message: "This attachment has no downloadable URL",
    });
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      ? ok(url)
      : err({
          kind: "invalid_response",
          message: "Asana returned a non-HTTPS download URL",
        });
  } catch {
    return err({
      kind: "invalid_response",
      message: "Asana returned an invalid download URL",
    });
  }
};

const inspectPath = async (
  path: string,
): Promise<
  Result<"missing" | "file" | "directory", AttachmentDownloadError>
> => {
  try {
    return ok((await stat(path)).isDirectory() ? "directory" : "file");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? ok("missing")
      : err({
          kind: "invalid_usage",
          message: "Unable to inspect output path",
        });
  }
};

const destinationFor = async (
  out: string,
  name: string,
  force: boolean,
): Promise<Result<string, AttachmentDownloadError>> => {
  const requested = resolve(out);
  const inspected = await inspectPath(requested);
  if (!inspected.ok) return inspected;
  const destination =
    inspected.value === "directory"
      ? join(requested, safeName(name))
      : requested;
  if (force) return ok(destination);
  const existing = await inspectPath(destination);
  if (!existing.ok) return existing;
  return existing.value === "missing"
    ? ok(destination)
    : err({
        kind: "invalid_usage",
        message: "Output already exists; use --force to replace it",
      });
};

const fetchDownload = async (
  url: URL,
  fetchBinary: FetchAttachment,
): Promise<Result<Response, AttachmentDownloadError>> => {
  try {
    // Signed URLs authorize the download; never forward the Asana bearer token.
    const response = await fetchBinary(url, { method: "GET" });
    return response.ok && response.body
      ? ok(response)
      : err({
          kind: "api",
          status: response.status,
          message: `Attachment download failed (${response.status})`,
        });
  } catch {
    return err({ kind: "network", message: "Unable to download attachment" });
  }
};

const saveDownload = async (
  destination: string,
  force: boolean,
  body: ReadableStream<Uint8Array>,
): Promise<Result<number, AttachmentDownloadError>> => {
  const temporaryPath = join(
    dirname(destination),
    `.asana-cli-${randomUUID()}.tmp`,
  );
  let bytes = 0;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      for await (const chunk of body) {
        await file.writeFile(chunk);
        bytes += chunk.byteLength;
      }
    } finally {
      await file.close();
    }
    if (force) await rename(temporaryPath, destination);
    else {
      await link(temporaryPath, destination);
      await unlink(temporaryPath);
    }
    return ok(bytes);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    return err({
      kind: "invalid_usage",
      message:
        (error as NodeJS.ErrnoException).code === "EEXIST"
          ? "Output already exists; use --force to replace it"
          : "Unable to write attachment to output path",
    });
  }
};

export const downloadAttachment = async (
  token: string,
  gid: string,
  out: string,
  force: boolean,
  reader: AttachmentGateway,
  fetchBinary: FetchAttachment = fetch,
): Promise<Result<AttachmentDownload, AttachmentDownloadError>> => {
  if (!/^\d+$/.test(gid))
    return err({ kind: "invalid_usage", message: "Invalid attachment GID" });
  if (out.trim() === "")
    return err({ kind: "invalid_usage", message: "--out cannot be empty" });
  const detail = await reader.getAttachment(token, gid);
  if (!detail.ok) return detail;
  const url = downloadUrl(detail.value.download_url);
  if (!url.ok) return url;
  const destination = await destinationFor(out, detail.value.name, force);
  if (!destination.ok) return destination;
  const response = await fetchDownload(url.value, fetchBinary);
  if (!response.ok) return response;
  const saved = await saveDownload(
    destination.value,
    force,
    response.value.body!,
  );
  return saved.ok
    ? ok({
        gid,
        path: destination.value,
        bytes: saved.value,
        content_type: response.value.headers.get("content-type"),
      })
    : saved;
};

import { open, rename, link, unlink, lstat, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { networkDeadlineSignal } from "../shared/network-deadline.ts";
import { ASANA_FAILURE_MESSAGES } from "../identity/index.ts";
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
  | Readonly<{ kind: "invalid_usage"; message: string }>
  | Readonly<{ kind: "already_exists"; message: string }>;

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

const alreadyExists = (): AttachmentDownloadError => ({
  kind: "already_exists",
  message: "Output already exists; use --force to replace it",
});

const inspectPath = async (
  path: string,
  followLinks = false,
): Promise<
  Result<"missing" | "file" | "directory", AttachmentDownloadError>
> => {
  try {
    const entry = await lstat(path);
    const inspected =
      followLinks && entry.isSymbolicLink()
        ? await stat(path).catch(() => entry)
        : entry;
    return ok(inspected.isDirectory() ? "directory" : "file");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? ok("missing")
      : err({
          kind: "invalid_usage",
          message: "Unable to inspect output path",
        });
  }
};

type DownloadTarget = Readonly<{
  gid: string;
  path: string;
  directory: boolean;
  force: boolean;
}>;

export const prepareAttachmentDownload = async (
  gid: string,
  out: string,
  force: boolean,
): Promise<Result<DownloadTarget, AttachmentDownloadError>> => {
  if (!/^\d+$/.test(gid))
    return err({ kind: "invalid_usage", message: "Invalid attachment GID" });
  if (out.trim() === "" || out.includes("\0"))
    return err({
      kind: "invalid_usage",
      message: "--out requires a valid path",
    });
  const path = resolve(out);
  const inspected = await inspectPath(path, true);
  if (!inspected.ok) return inspected;
  if (inspected.value === "file" && !force) return err(alreadyExists());
  const directory = inspected.value === "directory";
  if (!directory) {
    const parent = await inspectPath(dirname(path), true);
    if (!parent.ok) return parent;
    if (parent.value !== "directory") {
      return err({
        kind: "invalid_usage",
        message: "Output parent directory does not exist",
      });
    }
  }
  return ok({ gid, path, directory, force });
};

const downloadTimeout = (): TaskReadError => ({
  kind: "timeout",
  message: ASANA_FAILURE_MESSAGES.timeout,
});

const fetchDownload = async (
  url: URL,
  fetchBinary: FetchAttachment,
  signal: AbortSignal | undefined,
): Promise<Result<Response, AttachmentDownloadError>> => {
  try {
    // Signed URLs authorize the download; never forward the Asana bearer token.
    signal?.throwIfAborted();
    const response = await fetchBinary(url, {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
    });
    if (signal?.aborted) {
      void response.body?.cancel().catch(() => undefined);
      return err(downloadTimeout());
    }
    return response.ok && response.body
      ? ok(response)
      : err({
          kind: "api",
          status: response.status,
          message: `Attachment download failed (${response.status})`,
        });
  } catch {
    return err(
      signal?.aborted
        ? downloadTimeout()
        : { kind: "network", message: "Unable to download attachment" },
    );
  }
};

const saveDownload = async (
  destination: string,
  force: boolean,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
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
        signal?.throwIfAborted();
        await file.writeFile(chunk);
        bytes += chunk.byteLength;
      }
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    if (force) await rename(temporaryPath, destination);
    else {
      await link(temporaryPath, destination);
      await unlink(temporaryPath);
    }
    return ok(bytes);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (signal?.aborted) return err(downloadTimeout());
    return err(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? alreadyExists()
        : {
            kind: "invalid_usage",
            message: "Unable to write attachment to output path",
          },
    );
  }
};

export const downloadAttachment = async (
  token: string,
  target: DownloadTarget,
  reader: AttachmentGateway,
  fetchBinary: FetchAttachment = fetch,
): Promise<Result<AttachmentDownload, AttachmentDownloadError>> => {
  const { gid, path, force, directory } = target;
  const detail = await reader.getAttachment(token, gid);
  if (!detail.ok) return detail;
  const destination = directory
    ? join(path, safeName(detail.value.name))
    : path;
  const existing = await inspectPath(destination);
  if (!existing.ok) return existing;
  if (existing.value === "directory" || (existing.value === "file" && !force)) {
    return err(alreadyExists());
  }
  const url = downloadUrl(detail.value.download_url);
  if (!url.ok) return url;
  const signal = networkDeadlineSignal();
  const response = await fetchDownload(url.value, fetchBinary, signal);
  if (!response.ok) return response;
  const saved = await saveDownload(
    destination,
    force,
    response.value.body!,
    signal,
  );
  return saved.ok
    ? ok({
        gid,
        path: destination,
        bytes: saved.value,
        content_type: response.value.headers.get("content-type"),
      })
    : saved;
};

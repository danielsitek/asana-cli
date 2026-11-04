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
  const sanitized = basename(name.replaceAll("\\", "/")).replace(
    /[\x00-\x1f\x7f]/g,
    "_",
  );
  return sanitized === "." || sanitized === ".." || sanitized === ""
    ? "attachment"
    : sanitized;
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
  if (detail.value.download_url === null) {
    return err({
      kind: "api",
      message: "This attachment has no downloadable URL",
    });
  }
  let url: URL;
  try {
    url = new URL(detail.value.download_url);
  } catch {
    return err({
      kind: "invalid_response",
      message: "Asana returned an invalid download URL",
    });
  }
  if (url.protocol !== "https:") {
    return err({
      kind: "invalid_response",
      message: "Asana returned a non-HTTPS download URL",
    });
  }

  const requestedPath = resolve(out);
  let destination = requestedPath;
  try {
    if ((await stat(requestedPath)).isDirectory()) {
      destination = join(requestedPath, safeName(detail.value.name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return err({
        kind: "invalid_usage",
        message: "Unable to inspect output path",
      });
    }
  }

  if (!force) {
    try {
      await stat(destination);
      return err({
        kind: "invalid_usage",
        message: "Output already exists; use --force to replace it",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return err({
          kind: "invalid_usage",
          message: "Unable to inspect output path",
        });
      }
    }
  }

  let response: Response;
  try {
    // Signed URLs authorize the download; never forward the Asana bearer token.
    response = await fetchBinary(url, { method: "GET" });
  } catch {
    return err({ kind: "network", message: "Unable to download attachment" });
  }
  if (!response.ok || !response.body) {
    return err({
      kind: "api",
      status: response.status,
      message: `Attachment download failed (${response.status})`,
    });
  }

  const temporaryPath = join(
    dirname(destination),
    `.asana-cli-${randomUUID()}.tmp`,
  );
  let bytes = 0;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      for await (const chunk of response.body) {
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
  return ok({
    gid,
    path: destination,
    bytes,
    content_type: response.headers.get("content-type"),
  });
};

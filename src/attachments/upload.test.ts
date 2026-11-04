import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { err, ok } from "../shared/result.ts";
import type { TaskGateway } from "../tasks/index.ts";
import {
  executeAttachmentUpload,
  insertInlineImage,
  MAX_ATTACHMENT_BYTES,
  prepareAttachmentUpload,
  type AttachmentWriteGateway,
} from "./upload.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const fixture = async (
  name: string,
  contents = "image bytes",
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "asana-cli-upload-"));
  directories.push(directory);
  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
};

describe("attachment upload", () => {
  test("validates file, size, and image MIME before any write", async () => {
    const image = await fixture("capture.png");
    const text = await fixture("readme.txt");
    const prepared = await prepareAttachmentUpload("42", {
      file: image,
      inline: true,
    });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) expect(prepared.value.contentType).toBe("image/png");
    expect(
      (await prepareAttachmentUpload("42", { file: text, inline: true })).ok,
    ).toBe(false);
    expect((await prepareAttachmentUpload("42", { file: text })).ok).toBe(true);
    expect(
      (await prepareAttachmentUpload("42", { file: "/missing/file.png" })).ok,
    ).toBe(false);
    await truncate(image, MAX_ATTACHMENT_BYTES + 1);
    expect((await prepareAttachmentUpload("42", { file: image })).ok).toBe(
      false,
    );
  });

  test("inserts an image while preserving existing rich text", () => {
    expect(insertInlineImage("<body><p>Old</p></body>", "7", "append")).toEqual(
      ok('<body><p>Old</p><img data-asana-gid="7"></body>'),
    );
    expect(
      insertInlineImage("<body><p>Old</p></body>", "7", "prepend"),
    ).toEqual(ok('<body><img data-asana-gid="7"><p>Old</p></body>'));
    expect(insertInlineImage("", "7", "append")).toEqual(
      ok('<body><img data-asana-gid="7"></body>'),
    );
    expect(insertInlineImage("plain text", "7", "append").ok).toBe(false);
  });

  test("reads notes before upload and reports a partial write when insertion fails", async () => {
    const image = await fixture("capture.png");
    const prepared = await prepareAttachmentUpload("42", {
      file: image,
      inline: "prepend",
    });
    if (!prepared.ok) throw new Error("fixture failed");
    const calls: string[] = [];
    const reader: TaskGateway = {
      getTask: async () => {
        calls.push("read");
        return ok({ html_notes: "<body><p>Old</p></body>" });
      },
    };
    const writer: AttachmentWriteGateway = {
      uploadTaskAttachment: async () => {
        calls.push("upload");
        return ok({
          gid: "7",
          name: "capture.png",
          size: 11,
          content_type: "image/png",
        });
      },
      setTaskHtmlNotes: async (_token, _taskId, html) => {
        calls.push(html);
        return err({ kind: "api", message: "server detail" });
      },
    };
    const result = await executeAttachmentUpload(
      "token",
      prepared.value,
      reader,
      writer,
    );
    expect(calls).toEqual([
      "read",
      "upload",
      '<body><img data-asana-gid="7"><p>Old</p></body>',
    ]);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "partial",
        uploaded: {
          gid: "7",
          name: "capture.png",
          size: 11,
          content_type: "image/png",
        },
        failed: { kind: "api", message: "server detail" },
      },
    });
  });

  test("appends an inline image after reading the existing description", async () => {
    const image = await fixture("capture.png");
    const prepared = await prepareAttachmentUpload("42", {
      file: image,
      inline: true,
      name: "New capture.png",
    });
    if (!prepared.ok) throw new Error("fixture failed");
    const writes: string[] = [];
    const reader: TaskGateway = {
      getTask: async () => ok({ html_notes: "<body><p>Existing</p></body>" }),
    };
    const writer: AttachmentWriteGateway = {
      uploadTaskAttachment: async (_token, _id, file) => {
        expect(file.name).toBe("New capture.png");
        return ok({
          gid: "7",
          name: file.name,
          size: file.bytes.byteLength,
          content_type: file.contentType,
        });
      },
      setTaskHtmlNotes: async (_token, _id, html) => {
        writes.push(html);
        return ok(undefined);
      },
    };
    const result = await executeAttachmentUpload(
      "token",
      prepared.value,
      reader,
      writer,
    );
    expect(result.ok).toBe(true);
    expect(writes).toEqual([
      '<body><p>Existing</p><img data-asana-gid="7"></body>',
    ]);
  });

  test("rejects malformed existing HTML before uploading", async () => {
    const image = await fixture("capture.png");
    const prepared = await prepareAttachmentUpload("42", {
      file: image,
      inline: true,
    });
    if (!prepared.ok) throw new Error("fixture failed");
    const reader: TaskGateway = {
      getTask: async () => ok({ html_notes: "no body wrapper" }),
    };
    const writer: AttachmentWriteGateway = {
      uploadTaskAttachment: async () => {
        throw new Error("upload called");
      },
      setTaskHtmlNotes: async () => {
        throw new Error("write called");
      },
    };
    expect(
      (await executeAttachmentUpload("token", prepared.value, reader, writer))
        .ok,
    ).toBe(false);
  });
});

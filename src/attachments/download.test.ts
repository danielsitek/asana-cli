import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ok } from "../shared/result.ts";
import { downloadAttachment, type FetchAttachment } from "./download.ts";
import type { AttachmentGateway } from "./index.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const directory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "asana-cli-attachment-"));
  directories.push(path);
  return path;
};

const reader: AttachmentGateway = {
  listTaskAttachments: async () => {
    throw new Error("unused");
  },
  getAttachment: async () =>
    ok({
      gid: "7",
      name: "../image.png",
      download_url: "https://example.com/signed",
    }),
};

describe("attachment download", () => {
  test("downloads into a directory without leaking the token to the signed URL", async () => {
    const out = await directory();
    const downloaded = await downloadAttachment(
      "secret",
      "7",
      out,
      false,
      reader,
      async (_url, init) => {
        expect(init?.headers).toBeUndefined();
        return new Response("image-data", {
          headers: { "content-type": "image/png" },
        });
      },
    );
    expect(downloaded).toEqual({
      ok: true,
      value: {
        gid: "7",
        path: join(out, "image.png"),
        bytes: 10,
        content_type: "image/png",
      },
    });
    expect(await readFile(join(out, "image.png"), "utf8")).toBe("image-data");
  });

  test("refuses overwrite until force is explicit", async () => {
    const out = join(await directory(), "file.bin");
    await writeFile(out, "old");
    let requests = 0;
    const fetchBinary: FetchAttachment = async () => {
      requests += 1;
      return new Response("new");
    };
    expect(
      (await downloadAttachment("secret", "7", out, false, reader, fetchBinary))
        .ok,
    ).toBe(false);
    expect(requests).toBe(0);
    expect(await readFile(out, "utf8")).toBe("old");
    expect(
      (await downloadAttachment("secret", "7", out, true, reader, fetchBinary))
        .ok,
    ).toBe(true);
    expect(await readFile(out, "utf8")).toBe("new");
  });

  test("does not write when no download URL exists", async () => {
    const out = join(await directory(), "file.bin");
    const unavailable: AttachmentGateway = {
      ...reader,
      getAttachment: async () =>
        ok({ gid: "7", name: "file.bin", download_url: null }),
    };
    expect(
      await downloadAttachment("secret", "7", out, false, unavailable),
    ).toEqual({
      ok: false,
      error: {
        kind: "api",
        message: "This attachment has no downloadable URL",
      },
    });
  });
});

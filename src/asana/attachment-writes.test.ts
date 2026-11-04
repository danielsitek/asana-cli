import { afterEach, describe, expect, test } from "bun:test";

import { AsanaAttachmentWriter } from "./attachment-writes.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.stop(true)));

const serverFor = (
  fetcher: (request: Request) => Response | Promise<Response>,
): string => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fetcher });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/api/1.0`;
};

describe("AsanaAttachmentWriter", () => {
  test("uploads a multipart file with bearer authentication and metadata", async () => {
    const baseUrl = serverFor(async (request) => {
      expect(new URL(request.url).pathname).toBe("/api/1.0/attachments");
      expect(new URL(request.url).searchParams.get("opt_fields")).toBe(
        "gid,name,size",
      );
      expect(request.headers.get("authorization")).toBe("Bearer secret");
      expect(request.headers.get("content-type")).toStartWith(
        "multipart/form-data; boundary=",
      );
      const form = await request.formData();
      expect(form.get("parent")).toBe("42");
      const file = form.get("file");
      expect(file).toBeInstanceOf(File);
      if (!(file instanceof File)) throw new Error("missing file");
      expect(file.name).toBe("capture.png");
      expect(file.type).toBe("image/png");
      expect(await file.text()).toBe("bytes");
      return Response.json({ data: { gid: "7", name: "capture.png" } });
    });
    const result = await new AsanaAttachmentWriter({
      baseUrl,
    }).uploadTaskAttachment("secret", "42", {
      name: "capture.png",
      bytes: new TextEncoder().encode("bytes"),
      contentType: "image/png",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        gid: "7",
        name: "capture.png",
        size: 5,
        content_type: "image/png",
      },
    });
  });

  test("updates only html_notes after the upload", async () => {
    const baseUrl = serverFor(async (request) => {
      expect(request.method).toBe("PUT");
      expect(new URL(request.url).pathname).toBe("/api/1.0/tasks/42");
      expect(await request.json()).toEqual({
        data: { html_notes: '<body><img data-asana-gid="7"></body>' },
      });
      return Response.json({ data: { gid: "42" } });
    });
    expect(
      await new AsanaAttachmentWriter({ baseUrl }).setTaskHtmlNotes(
        "secret",
        "42",
        '<body><img data-asana-gid="7"></body>',
      ),
    ).toEqual({ ok: true, value: undefined });
  });
});

import { describe, expect, test } from "bun:test";

import { ok } from "../shared/result.ts";
import {
  executeAttachmentList,
  prepareAttachmentList,
  type AttachmentGateway,
} from "./index.ts";

describe("task attachments", () => {
  test("validates bounded reads and field selection", () => {
    expect(prepareAttachmentList("https://app.asana.com/0/1/42", {})).toEqual({
      ok: true,
      value: {
        taskId: "42",
        fields: [
          "gid",
          "name",
          "resource_subtype",
          "size",
          "created_at",
          "parent.gid",
        ],
        scanCap: 100,
        resultCap: 20,
      },
    });
    expect(prepareAttachmentList("42", { all: true }).ok).toBe(false);
    expect(prepareAttachmentList("42", { fields: "" }).ok).toBe(false);
  });

  test("follows Asana offsets without exceeding the cap", async () => {
    const offsets: Array<string | undefined> = [];
    const reader: AttachmentGateway = {
      listTaskAttachments: async (_token, _taskId, options) => {
        offsets.push(options.offset);
        return ok(
          options.offset === undefined
            ? { attachments: [{ gid: "1" }], nextOffset: "next" }
            : { attachments: [{ gid: "2" }], nextOffset: "later" },
        );
      },
      getAttachment: async () => {
        throw new Error("unused");
      },
    };
    const prepared = prepareAttachmentList("42", { max: "2", all: true });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const result = await executeAttachmentList("token", prepared.value, reader);
    expect(offsets).toEqual([undefined, "next"]);
    expect(result).toEqual({
      ok: true,
      value: {
        attachments: [{ gid: "1" }, { gid: "2" }],
        meta: {
          scanned: 2,
          returned: 2,
          scan_truncated: true,
          next_offset: "later",
        },
      },
    });
  });
});

import { describe, expect, test } from "bun:test";

import { err, ok } from "../shared/result.ts";
import {
  executeProjectSectionList,
  prepareProjectSectionList,
  type ProjectReadError,
  type ProjectSectionGateway,
  type ProjectSectionPage,
} from "./index.ts";

class SectionReader implements ProjectSectionGateway {
  public readonly calls: Parameters<
    ProjectSectionGateway["listProjectSections"]
  >[0][] = [];

  constructor(
    private readonly pages: readonly (
      | ReturnType<typeof ok<ProjectSectionPage>>
      | ReturnType<typeof err<ProjectReadError>>
    )[],
  ) {}

  listProjectSections(
    request: Parameters<ProjectSectionGateway["listProjectSections"]>[0],
  ) {
    this.calls.push(request);
    const page = this.pages[this.calls.length - 1];
    if (page === undefined) throw new Error("no page queued");
    return Promise.resolve(page);
  }
}

describe("project section listing", () => {
  test("prepares defaults and validates bounded options", () => {
    expect(
      prepareProjectSectionList({ projectGid: "100", fields: ["gid", "name"] }),
    ).toEqual({
      ok: true,
      value: {
        projectGid: "100",
        scanCap: 100,
        resultCap: 20,
        fields: ["gid", "name"],
      },
    });
    for (const options of [
      { projectGid: "abc", fields: ["gid"] },
      { projectGid: "100", max: "0", fields: ["gid"] },
      { projectGid: "100", all: true, fields: ["gid"] },
    ]) {
      expect(prepareProjectSectionList(options).ok).toBe(false);
    }
  });

  test("preserves API order, fields, pagination, and metadata", async () => {
    const reader = new SectionReader([
      ok({
        sections: [{ name: "One", gid: "1" }],
        nextOffset: "page-2",
      }),
      ok({ sections: [{ name: "Two", gid: "2" }] }),
    ]);
    const prepared = prepareProjectSectionList({
      projectGid: "100",
      max: "2",
      all: true,
      fields: ["name", "gid"],
    });
    if (!prepared.ok) throw new Error("expected prepared request");

    const result = await executeProjectSectionList("token", prepared.value, {
      reader,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        sections: [
          { name: "One", gid: "1" },
          { name: "Two", gid: "2" },
        ],
        meta: { scanned: 2, returned: 2, scan_truncated: false },
      },
    });
    expect(reader.calls).toEqual([
      {
        token: "token",
        projectGid: "100",
        limit: 2,
        fields: ["name", "gid"],
      },
      {
        token: "token",
        projectGid: "100",
        limit: 1,
        offset: "page-2",
        fields: ["name", "gid"],
      },
    ]);
  });

  test("caps default results and reports scan truncation", async () => {
    const reader = new SectionReader([
      ok({
        sections: Array.from({ length: 21 }, (_, index) => ({
          gid: String(index + 1),
          name: `Section ${index + 1}`,
        })),
      }),
    ]);
    const prepared = prepareProjectSectionList({
      projectGid: "100",
      fields: ["gid", "name"],
    });
    if (!prepared.ok) throw new Error("expected prepared request");
    const result = await executeProjectSectionList("token", prepared.value, {
      reader,
    });
    expect(result.ok && result.value.sections).toHaveLength(20);
    expect(result.ok && result.value.meta).toEqual({
      scanned: 20,
      returned: 20,
      scan_truncated: false,
    });
  });

  test.each([
    ["empty page", [ok({ sections: [], nextOffset: "next" })]],
    [
      "non-advancing offset",
      [
        ok({ sections: [{ gid: "1" }], nextOffset: "same" }),
        ok({ sections: [{ gid: "2" }], nextOffset: "same" }),
      ],
    ],
    [
      "cycling offset",
      [
        ok({ sections: [{ gid: "1" }], nextOffset: "a" }),
        ok({ sections: [{ gid: "2" }], nextOffset: "b" }),
        ok({ sections: [{ gid: "3" }], nextOffset: "a" }),
      ],
    ],
  ])("rejects %s pagination", async (_name, pages) => {
    const prepared = prepareProjectSectionList({
      projectGid: "100",
      max: "4",
      all: true,
      fields: ["gid"],
    });
    if (!prepared.ok) throw new Error("expected prepared request");
    const result = await executeProjectSectionList("token", prepared.value, {
      reader: new SectionReader(pages),
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Project section pagination did not advance",
      },
    });
  });
});

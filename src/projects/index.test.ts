import { describe, expect, test } from "bun:test";

import { err, ok, type Result } from "../shared/result.ts";
import {
  executeProjectSectionList,
  prepareProjectSectionList,
  executeProjectCustomFieldSettingList,
  prepareProjectCustomFieldSettingList,
  type ProjectReadError,
  type ProjectSectionGateway,
  type ProjectSectionPage,
  type ProjectCustomFieldSettingGateway,
  type ProjectCustomFieldSettingPage,
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

describe("project custom-field settings", () => {
  const prepare = (options: Readonly<Record<string, unknown>> = {}) => {
    const result = prepareProjectCustomFieldSettingList({
      projectGid: "100",
      fields: ["gid"],
      ...options,
    });
    if (!result.ok) throw new Error("expected prepared request");
    return result.value;
  };

  const readerFor = (
    pages: readonly Result<ProjectCustomFieldSettingPage, ProjectReadError>[],
  ) => {
    const calls: Parameters<
      ProjectCustomFieldSettingGateway["listProjectCustomFieldSettings"]
    >[0][] = [];
    return {
      calls,
      reader: {
        listProjectCustomFieldSettings(request) {
          calls.push(request);
          const page = pages[calls.length - 1];
          if (page === undefined) throw new Error("no setting page queued");
          return Promise.resolve(page);
        },
      } satisfies ProjectCustomFieldSettingGateway,
    };
  };

  test("prepares exact defaults and max/all semantics", () => {
    expect(
      prepareProjectCustomFieldSettingList({
        projectGid: "100",
        fields: ["gid", "custom_field.gid"],
      }),
    ).toEqual({
      ok: true,
      value: {
        projectGid: "100",
        scanCap: 100,
        resultCap: 20,
        fields: ["gid", "custom_field.gid"],
      },
    });
    expect(prepare({ max: "101", all: true })).toEqual({
      projectGid: "100",
      scanCap: 101,
      fields: ["gid"],
    });
    for (const options of [
      { projectGid: "bad", fields: ["gid"] },
      { projectGid: "100", max: "0", fields: ["gid"] },
      { projectGid: "100", all: true, fields: ["gid"] },
    ])
      expect(prepareProjectCustomFieldSettingList(options).ok).toBe(false);
  });

  test("uses API order, selected fields, default result cap, and metadata", async () => {
    const { calls, reader } = readerFor([
      ok({
        settings: Array.from({ length: 21 }, (_, index) => ({
          gid: String(index + 1),
        })),
      }),
    ]);
    const result = await executeProjectCustomFieldSettingList(
      "token",
      prepare({ fields: ["custom_field.name", "gid"] }),
      { reader },
    );
    expect(result).toEqual({
      ok: true,
      value: {
        settings: Array.from({ length: 20 }, (_, index) => ({
          gid: String(index + 1),
        })),
        meta: { scanned: 20, returned: 20, scan_truncated: false },
      },
    });
    expect(calls).toEqual([
      {
        token: "token",
        projectGid: "100",
        limit: 100,
        fields: ["custom_field.name", "gid"],
      },
    ]);
  });

  test("uses 100 per call, remaining budget, and next offset", async () => {
    const { calls, reader } = readerFor([
      ok({
        settings: Array.from({ length: 100 }, () => ({ gid: "1" })),
        nextOffset: "next",
      }),
      ok({ settings: [{ gid: "101" }, { gid: "102" }] }),
    ]);
    const result = await executeProjectCustomFieldSettingList(
      "token",
      prepare({ max: "102", all: true }),
      { reader },
    );
    expect(result.ok && result.value.meta).toEqual({
      scanned: 102,
      returned: 102,
      scan_truncated: false,
    });
    expect(calls).toEqual([
      { token: "token", projectGid: "100", limit: 100, fields: ["gid"] },
      {
        token: "token",
        projectGid: "100",
        limit: 2,
        offset: "next",
        fields: ["gid"],
      },
    ]);
  });

  test.each([
    ["empty", [ok({ settings: [], nextOffset: "next" })]],
    [
      "non-advancing",
      [
        ok({ settings: [{ gid: "1" }], nextOffset: "same" }),
        ok({ settings: [{ gid: "2" }], nextOffset: "same" }),
      ],
    ],
    [
      "cyclic",
      [
        ok({ settings: [{ gid: "1" }], nextOffset: "a" }),
        ok({ settings: [{ gid: "2" }], nextOffset: "b" }),
        ok({ settings: [{ gid: "3" }], nextOffset: "a" }),
      ],
    ],
  ])("rejects %s pagination offsets", async (_name, pages) => {
    const { reader } = readerFor(pages);
    await expect(
      executeProjectCustomFieldSettingList(
        "token",
        prepare({ max: "4", all: true }),
        { reader },
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Project custom field setting pagination did not advance",
      },
    });
  });

  test("propagates gateway failures unchanged", async () => {
    const failure: ProjectReadError = { kind: "network", message: "offline" };
    const { reader } = readerFor([err(failure)]);
    await expect(
      executeProjectCustomFieldSettingList("token", prepare(), { reader }),
    ).resolves.toEqual({ ok: false, error: failure });
  });
});

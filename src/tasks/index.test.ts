import { describe, expect, test } from "bun:test";

import { DEFAULT_FIELDS, parseTaskId, validateFieldList } from "./index.ts";

describe("DEFAULT_FIELDS", () => {
  test("selects the supported task detail fields", () => {
    expect(DEFAULT_FIELDS).toEqual([
      "gid",
      "name",
      "notes",
      "completed",
      "due_on",
      "assignee.gid",
      "assignee.name",
    ]);
  });
});

describe("parseTaskId", () => {
  test("accepts digit-only GIDs", () => {
    expect(parseTaskId("1234567890")).toEqual({
      ok: true,
      value: "1234567890",
    });
  });

  test("accepts unambiguous Asana task URLs", () => {
    expect(
      parseTaskId("https://app.asana.com/0/1201947864389005/1215978111726134"),
    ).toEqual({
      ok: true,
      value: "1215978111726134",
    });
    expect(
      parseTaskId(
        "https://app.asana.com/0/1201947864389005/1215978111726134/f",
      ),
    ).toEqual({
      ok: true,
      value: "1215978111726134",
    });
  });

  test("rejects invalid or ambiguous URLs and non-digit GIDs", () => {
    for (const input of [
      "https://app.asana.com/0/1201947864389005/1215978111726134/",
      "https://app.asana.com/0/1201947864389005/1215978111726134/f/",
      "abc",
      "123a456",
      "https://app.asana.com/0/1201947864389005/1215978111726134/other",
      "https://app.asana.com/0/1201947864389005/list",
    ]) {
      expect(parseTaskId(input)).toEqual({
        ok: false,
        error: "Invalid task identifier",
      });
    }
  });
});

describe("validateFieldList", () => {
  test("trims fields and removes duplicates in first-seen order", () => {
    expect(validateFieldList(" notes, name,notes,assignee.gid ")).toEqual({
      ok: true,
      value: ["notes", "name", "assignee.gid"],
    });
  });

  test("rejects empty lists and segments", () => {
    expect(validateFieldList("  ")).toEqual({
      ok: false,
      error: "Fields list cannot be empty",
    });
    expect(validateFieldList("name,,notes")).toEqual({
      ok: false,
      error: "Fields list cannot contain empty segments",
    });
  });
});

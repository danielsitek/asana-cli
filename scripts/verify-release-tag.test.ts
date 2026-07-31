import { describe, expect, test } from "bun:test";

import { verifyReleaseTag } from "./verify-release-tag.ts";

describe("release tag validation", () => {
  test("accepts the exact stable package version", async () => {
    await expect(verifyReleaseTag("v0.1.0")).resolves.toBe("0.1.0");
  });

  test("rejects version mismatches and non-stable tags", async () => {
    for (const tag of ["v0.2.0", "0.1.0", "v0.1.0-rc.1", "v01.1.0"]) {
      await expect(verifyReleaseTag(tag)).rejects.toThrow();
    }
  });
});

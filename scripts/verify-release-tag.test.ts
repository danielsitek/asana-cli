import { describe, expect, test } from "bun:test";

import {
  runVerifyReleaseTagCli,
  verifyReleaseTag,
} from "./verify-release-tag.ts";

describe("release tag validation", () => {
  test("accepts the exact stable package version", async () => {
    await expect(verifyReleaseTag("v0.2.0")).resolves.toBe("0.2.0");
  });

  test("rejects version mismatches and non-stable tags", async () => {
    for (const tag of ["v0.1.0", "0.2.0", "v0.2.0-rc.1", "v02.0.0"]) {
      await expect(verifyReleaseTag(tag)).rejects.toThrow();
    }
  });

  describe("CLI entry point", () => {
    test("validates and verifies parsed arguments", async () => {
      await expect(runVerifyReleaseTagCli([])).rejects.toThrow(
        "Usage: verify-release-tag.ts --tag <tag>",
      );
      await expect(runVerifyReleaseTagCli(["--tag", "v0.2.0"])).resolves.toBe(
        undefined,
      );
    });

    test("fails with a usage message when --tag is missing", async () => {
      const proc = Bun.spawn(["bun", "run", "verify-release-tag.ts"], {
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).not.toBe(0);
      expect(stderr).toContain("Usage: verify-release-tag.ts --tag <tag>");
    });

    test("succeeds when invoked with the matching stable tag", async () => {
      const proc = Bun.spawn(
        ["bun", "run", "verify-release-tag.ts", "--tag", "v0.2.0"],
        { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
      );
      expect(await proc.exited).toBe(0);
    });
  });
});

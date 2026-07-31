import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { releaseTargets } from "./build.ts";
import {
  generateHomebrewFormula,
  runGenerateHomebrewFormulaCli,
} from "./generate-homebrew-formula.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const fixture = async (lines?: readonly string[]) => {
  const root = await mkdtemp(`${tmpdir()}/asana-cli-formula-test-`);
  temporaryDirectories.push(root);
  const checksumPath = join(root, "SHA256SUMS");
  const outputPath = join(root, "asana-cli.rb");
  const manifest =
    lines ??
    Object.keys(releaseTargets).map(
      (target, index) =>
        `${String(index + 1).repeat(64)}  asana-cli-v0.1.0-${target}.tar.gz`,
    );
  await writeFile(checksumPath, `${manifest.join("\n")}\n`);
  return { checksumPath, outputPath };
};

describe("Homebrew formula generator", () => {
  test("generates architecture-specific URLs and checksums", async () => {
    const setup = await fixture();
    const formula = await generateHomebrewFormula({
      ...setup,
      version: "0.1.0",
      repository: "owner/project",
    });
    expect(formula).toContain("class AsanaCli < Formula");
    expect(formula).toContain('license "MIT"');
    expect(formula).toContain(
      "https://github.com/owner/project/releases/download/v0.1.0/asana-cli-v0.1.0-darwin-arm64.tar.gz",
    );
    expect(formula).toContain(`sha256 "${"1".repeat(64)}"`);
    expect(formula).toContain(`sha256 "${"2".repeat(64)}"`);
    expect(formula).toContain("tasks get invalid 2>&1");

    const syntax = Bun.spawn(["ruby", "-c", setup.outputPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await syntax.exited).toBe(0);
  });

  test("rejects missing, duplicate, and malformed checksums", async () => {
    const validLines = Object.keys(releaseTargets).map(
      (target, index) =>
        `${String(index + 1).repeat(64)}  asana-cli-v0.1.0-${target}.tar.gz`,
    );
    const cases = [
      {
        lines: validLines.slice(0, -1),
        message: "Missing checksum target: linux-arm64",
      },
      {
        lines: [...validLines, validLines[0]!],
        message: "Duplicate checksum target: darwin-arm64",
      },
      {
        lines: ["not-a-checksum", ...validLines.slice(1)],
        message: "Malformed checksum line",
      },
      {
        lines: [
          `${"a".repeat(63)}  ${validLines[0]!.split("  ")[1]}`,
          ...validLines.slice(1),
        ],
        message: "Malformed checksum",
      },
    ];
    for (const item of cases) {
      const setup = await fixture(item.lines);
      await expect(
        generateHomebrewFormula({ ...setup, version: "0.1.0" }),
      ).rejects.toThrow(item.message);
    }
  });

  test("supports local archive URLs for pre-release installation tests", async () => {
    const setup = await fixture();
    const formula = await generateHomebrewFormula({
      ...setup,
      version: "0.1.0",
      baseUrl: "file:///tmp/current-run-assets",
    });
    expect(formula).toContain(
      "file:///tmp/current-run-assets/asana-cli-v0.1.0-darwin-arm64.tar.gz",
    );
  });

  test("rejects a repository that is not owner/name", async () => {
    const setup = await fixture();
    await expect(
      generateHomebrewFormula({
        ...setup,
        version: "0.1.0",
        repository: "not-a-valid-repository!!",
      }),
    ).rejects.toThrow("Repository must use owner/name format");
  });

  describe("CLI entry point", () => {
    test("validates required arguments without starting generation", async () => {
      await expect(runGenerateHomebrewFormulaCli([])).rejects.toThrow(
        "Usage: generate-homebrew-formula.ts",
      );
    });

    test("generates a formula from parsed arguments", async () => {
      const setup = await fixture();
      await runGenerateHomebrewFormulaCli([
        "--checksums",
        setup.checksumPath,
        "--output",
        setup.outputPath,
        "--version",
        "0.1.0",
        "--repository",
        "owner/project",
        "--base-url",
        "file:///tmp/current-run-assets",
      ]);
      expect(await Bun.file(setup.outputPath).text()).toContain(
        "file:///tmp/current-run-assets/asana-cli-v0.1.0-darwin-arm64.tar.gz",
      );
    });

    test("fails with a usage message when required flags are missing", async () => {
      const proc = Bun.spawn(["bun", "run", "generate-homebrew-formula.ts"], {
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).not.toBe(0);
      expect(stderr).toContain(
        "Usage: generate-homebrew-formula.ts --checksums <path> --output <path> --version <x.y.z>",
      );
    });

    test("writes a formula file when invoked with required and optional flags", async () => {
      const setup = await fixture();
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          "generate-homebrew-formula.ts",
          "--checksums",
          setup.checksumPath,
          "--output",
          setup.outputPath,
          "--version",
          "0.1.0",
          "--repository",
          "owner/project",
          "--base-url",
          "file:///tmp/current-run-assets",
        ],
        { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
      );
      expect(await proc.exited).toBe(0);
      const written = await Bun.file(setup.outputPath).text();
      expect(written).toContain(
        "file:///tmp/current-run-assets/asana-cli-v0.1.0-darwin-arm64.tar.gz",
      );
    });
  });
});

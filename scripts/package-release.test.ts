import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { releaseTargets } from "./build.ts";
import { packageRelease } from "./package-release.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const fixture = async () => {
  const root = await mkdtemp(`${tmpdir()}/asana-cli-package-test-`);
  temporaryDirectories.push(root);
  const inputDirectory = join(root, "input");
  const outputDirectory = join(root, "output");
  const licensePath = join(root, "LICENSE");
  await writeFile(licensePath, "MIT fixture\n");
  for (const target of Object.keys(releaseTargets)) {
    await mkdir(join(inputDirectory, target), { recursive: true });
    await writeFile(join(inputDirectory, target, "asana-cli"), target);
  }
  return { inputDirectory, outputDirectory, licensePath };
};

describe("release packaging", () => {
  test("fails before packaging when a target is missing", async () => {
    const setup = await fixture();
    await rm(join(setup.inputDirectory, "linux-arm64", "asana-cli"));
    let commands = 0;
    await expect(
      packageRelease({ ...setup, version: "0.1.0" }, async () => {
        commands += 1;
      }),
    ).rejects.toThrow("Missing release executable for linux-arm64");
    expect(commands).toBe(0);
  });

  test("creates deterministic archive names and a sorted checksum manifest", async () => {
    const setup = await fixture();
    const commands: readonly string[][] = [];
    const mutableCommands = commands as string[][];
    const run = async (command: readonly string[]) => {
      mutableCommands.push([...command]);
      if (command[0] === "tar") {
        const tarPath = command[command.indexOf("-cf") + 1]!;
        await writeFile(tarPath, "normalized tar fixture");
      }
      if (command[0] === "gzip") {
        const tarPath = command.at(-1)!;
        await writeFile(`${tarPath}.gz`, await Bun.file(tarPath).bytes());
        await rm(tarPath);
      }
    };

    const packaged = await packageRelease({ ...setup, version: "0.1.0" }, run);
    expect(packaged.archives.map((path) => path.split("/").at(-1))).toEqual([
      "asana-cli-v0.1.0-darwin-arm64.tar.gz",
      "asana-cli-v0.1.0-darwin-x64.tar.gz",
      "asana-cli-v0.1.0-linux-x64-baseline.tar.gz",
      "asana-cli-v0.1.0-linux-arm64.tar.gz",
    ]);
    const manifest = await Bun.file(packaged.checksumPath).text();
    expect(manifest.trim().split("\n")).toHaveLength(4);
    expect(manifest).toContain("  asana-cli-v0.1.0-darwin-arm64.tar.gz");
    expect(commands.filter(([command]) => command === "tar")).toHaveLength(4);
    expect(commands[0]).toEqual(
      expect.arrayContaining([
        "--sort=name",
        "--owner=0",
        "--group=0",
        "--mtime=@0",
        "--pax-option=delete=atime,delete=ctime",
      ]),
    );
    expect(commands.at(-1)?.slice(0, 2)).toEqual(["sha256sum", "-c"]);
  });

  test("rejects malformed versions", async () => {
    const setup = await fixture();
    await expect(
      packageRelease({ ...setup, version: "v0.1" }, async () => undefined),
    ).rejects.toThrow();
  });
});

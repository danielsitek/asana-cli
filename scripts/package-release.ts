import { chmod, copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { z } from "zod";

import { releaseTargets, type ReleaseTarget } from "./build.ts";

type RunCommand = (
  command: readonly string[],
  options?: Readonly<{ cwd?: string }>,
) => Promise<void>;

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const releaseTargetNames = Object.keys(releaseTargets) as ReleaseTarget[];

const defaultRunCommand: RunCommand = async (command, options = {}) => {
  const child = Bun.spawn([...command], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, LC_ALL: "C" },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command[0] ?? "Command"} failed with exit ${exitCode}`);
  }
};

export const packageRelease = async (
  options: Readonly<{
    inputDirectory: string;
    outputDirectory: string;
    version: string;
    licensePath?: string;
  }>,
  runCommand: RunCommand = defaultRunCommand,
): Promise<Readonly<{ archives: readonly string[]; checksumPath: string }>> => {
  const version = versionSchema.parse(options.version);
  const inputDirectory = resolve(options.inputDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  const licensePath = resolve(options.licensePath ?? "LICENSE");

  await stat(licensePath);
  for (const target of releaseTargetNames) {
    const binary = join(inputDirectory, target, "asana-cli");
    const metadata = await stat(binary).catch(() => undefined);
    if (metadata === undefined || !metadata.isFile()) {
      throw new Error(`Missing release executable for ${target}`);
    }
  }

  await mkdir(outputDirectory, { recursive: true });
  const stagingRoot = join(outputDirectory, ".staging");
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  const archives: string[] = [];
  const checksums: string[] = [];
  try {
    for (const target of releaseTargetNames) {
      const stagingDirectory = join(stagingRoot, target);
      await mkdir(stagingDirectory, { recursive: true });
      await copyFile(
        join(inputDirectory, target, "asana-cli"),
        join(stagingDirectory, "asana-cli"),
      );
      await copyFile(licensePath, join(stagingDirectory, "LICENSE"));
      await chmod(join(stagingDirectory, "asana-cli"), 0o755);
      await chmod(join(stagingDirectory, "LICENSE"), 0o644);

      const archiveName = `asana-cli-v${version}-${target}.tar.gz`;
      const tarPath = join(outputDirectory, archiveName.slice(0, -3));
      const archivePath = join(outputDirectory, archiveName);
      await rm(tarPath, { force: true });
      await rm(archivePath, { force: true });
      await runCommand([
        "tar",
        "--sort=name",
        "--format=pax",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--mtime=@0",
        "--mode=u+rwX,go+rX,go-w",
        "--pax-option=delete=atime,delete=ctime",
        "-cf",
        tarPath,
        "-C",
        stagingDirectory,
        "LICENSE",
        "asana-cli",
      ]);
      await runCommand(["gzip", "-n", "-9", "-f", tarPath]);

      const digest = new Bun.CryptoHasher("sha256")
        .update(await Bun.file(archivePath).arrayBuffer())
        .digest("hex");
      archives.push(archivePath);
      checksums.push(`${digest}  ${archiveName}`);
    }

    const checksumPath = join(outputDirectory, "SHA256SUMS");
    await writeFile(checksumPath, `${checksums.sort().join("\n")}\n`);
    await runCommand(["sha256sum", "-c", basename(checksumPath)], {
      cwd: outputDirectory,
    });
    return { archives, checksumPath };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const valueAfter = (flag: string): string | undefined => {
    const index = Bun.argv.indexOf(flag);
    return index === -1 ? undefined : Bun.argv[index + 1];
  };
  const inputDirectory = valueAfter("--input");
  const outputDirectory = valueAfter("--output");
  const version = valueAfter("--version");
  if (
    inputDirectory === undefined ||
    outputDirectory === undefined ||
    version === undefined
  ) {
    throw new Error(
      "Usage: package-release.ts --input <dir> --output <dir> --version <x.y.z>",
    );
  }
  await packageRelease({ inputDirectory, outputDirectory, version });
}

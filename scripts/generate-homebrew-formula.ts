import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { releaseTargets, type ReleaseTarget } from "./build.ts";

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const releaseTargetNames = Object.keys(releaseTargets) as ReleaseTarget[];

const parseChecksums = (
  manifest: string,
  version: string,
): Readonly<Record<ReleaseTarget, string>> => {
  const expectedFiles = new Map(
    releaseTargetNames.map((target) => [
      `asana-cli-v${version}-${target}.tar.gz`,
      target,
    ]),
  );
  const checksums = new Map<ReleaseTarget, string>();

  for (const line of manifest.split("\n").filter((value) => value !== "")) {
    const match = /^([0-9a-f]+) {2}(\S+)$/.exec(line);
    if (match === null) throw new Error(`Malformed checksum line: ${line}`);
    const checksum = sha256Schema.safeParse(match[1]);
    if (!checksum.success)
      throw new Error(`Malformed checksum for ${match[2]}`);
    const target = expectedFiles.get(match[2]!);
    if (target === undefined)
      throw new Error(`Unexpected checksum target: ${match[2]}`);
    if (checksums.has(target))
      throw new Error(`Duplicate checksum target: ${target}`);
    checksums.set(target, checksum.data);
  }

  for (const target of releaseTargetNames) {
    if (!checksums.has(target))
      throw new Error(`Missing checksum target: ${target}`);
  }
  return Object.fromEntries(checksums) as Record<ReleaseTarget, string>;
};

export const generateHomebrewFormula = async (
  options: Readonly<{
    checksumPath: string;
    outputPath: string;
    version: string;
    repository?: string;
    baseUrl?: string;
  }>,
): Promise<string> => {
  const version = versionSchema.parse(options.version);
  const repository = options.repository ?? "danielsitek/asana-cli";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Repository must use owner/name format");
  }
  const manifest = await Bun.file(resolve(options.checksumPath)).text();
  const checksums = parseChecksums(manifest, version);
  const baseUrl =
    options.baseUrl ??
    `https://github.com/${repository}/releases/download/v${version}`;
  const archiveUrl = (target: ReleaseTarget) =>
    `${baseUrl}/asana-cli-v${version}-${target}.tar.gz`;
  const versionLine =
    options.baseUrl === undefined ? "" : `  version "${version}"\n`;

  const formula = `class AsanaCli < Formula
  desc "Command-line interface for safe Asana task workflows"
  homepage "https://github.com/${repository}"
${versionLine}  license "MIT"

  on_macos do
    on_arm do
      url "${archiveUrl("darwin-arm64")}"
      sha256 "${checksums["darwin-arm64"]}"
    end
    on_intel do
      url "${archiveUrl("darwin-x64")}"
      sha256 "${checksums["darwin-x64"]}"
    end
  end

  def install
    bin.install "asana-cli"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/asana-cli --version")
    output = shell_output("#{bin}/asana-cli tasks get invalid 2>&1", 2)
    assert_match '"code":"invalid_usage"', output
  end
end
`;
  const outputPath = resolve(options.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, formula);
  return formula;
};

const valueAfter = (
  args: readonly string[],
  flag: string,
): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

export const runGenerateHomebrewFormulaCli = async (
  args: readonly string[],
): Promise<void> => {
  const checksumPath = valueAfter(args, "--checksums");
  const outputPath = valueAfter(args, "--output");
  const version = valueAfter(args, "--version");
  if (
    checksumPath === undefined ||
    outputPath === undefined ||
    version === undefined
  ) {
    throw new Error(
      "Usage: generate-homebrew-formula.ts --checksums <path> --output <path> --version <x.y.z>",
    );
  }
  const repository = valueAfter(args, "--repository");
  const baseUrl = valueAfter(args, "--base-url");
  await generateHomebrewFormula({
    checksumPath,
    outputPath,
    version,
    ...(repository === undefined ? {} : { repository }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
};

if (import.meta.main) await runGenerateHomebrewFormulaCli(Bun.argv.slice(2));

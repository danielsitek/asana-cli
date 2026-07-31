import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

export const releaseTargets = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64-baseline": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
} as const satisfies Record<string, Bun.Build.CompileTarget>;

export type ReleaseTarget = keyof typeof releaseTargets;

type BuildResult = Readonly<{
  success: boolean;
  logs: readonly unknown[];
}>;

type BuildExecutable = (
  config: Bun.BuildConfig,
) => Promise<BuildResult> | BuildResult;

const packageManifest = z.object({ version: z.string().min(1) });

const releaseTargetNames = Object.keys(releaseTargets) as ReleaseTarget[];

const selectedTargets = (
  args: readonly string[],
): readonly (ReleaseTarget | undefined)[] => {
  if (args.length === 0) return [undefined];
  if (args.length === 1 && args[0] === "--all") return releaseTargetNames;
  if (args.length === 2 && args[0] === "--target") {
    const target = args[1];
    if (target !== undefined && Object.hasOwn(releaseTargets, target)) {
      return [target as ReleaseTarget];
    }
    throw new Error(`Unknown release target: ${target ?? ""}`);
  }
  throw new Error("Usage: build.ts [--all | --target <release-target>]");
};

export const runBuild = async (
  args: readonly string[],
  build: BuildExecutable = Bun.build,
): Promise<readonly string[]> => {
  const { version } = packageManifest.parse(
    await Bun.file(new URL("../package.json", import.meta.url)).json(),
  );
  const outputs: string[] = [];

  for (const target of selectedTargets(args)) {
    const outfile =
      target === undefined
        ? "dist/asana-cli"
        : `dist/release/${target}/asana-cli`;
    await mkdir(dirname(outfile), { recursive: true });
    const result = await build({
      entrypoints: ["src/main.ts"],
      minify: true,
      sourcemap: "inline",
      define: { __APP_VERSION__: JSON.stringify(version) },
      compile: {
        ...(target === undefined ? {} : { target: releaseTargets[target] }),
        outfile,
        autoloadDotenv: false,
        autoloadBunfig: false,
      },
    });
    if (!result.success) {
      throw new AggregateError(
        result.logs,
        `Failed to build ${target ?? "host"}`,
      );
    }
    outputs.push(outfile);
  }

  return outputs;
};

if (import.meta.main) await runBuild(Bun.argv.slice(2));

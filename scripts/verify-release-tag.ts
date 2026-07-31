import { z } from "zod";

const packageManifest = z.object({
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
});

export const verifyReleaseTag = async (tag: string): Promise<string> => {
  const { version } = packageManifest.parse(
    await Bun.file(new URL("../package.json", import.meta.url)).json(),
  );
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
    throw new Error(`Release tag is not stable SemVer: ${tag}`);
  }
  if (tag !== `v${version}`) {
    throw new Error(
      `Release tag ${tag} does not match package version ${version}`,
    );
  }
  return version;
};

export const runVerifyReleaseTagCli = async (
  args: readonly string[],
): Promise<void> => {
  const tagIndex = args.indexOf("--tag");
  const tag = tagIndex === -1 ? undefined : args[tagIndex + 1];
  if (tag === undefined)
    throw new Error("Usage: verify-release-tag.ts --tag <tag>");
  await verifyReleaseTag(tag);
};

if (import.meta.main) await runVerifyReleaseTagCli(Bun.argv.slice(2));

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const latestReleaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.url(),
});

const updateCacheSchema = z.object({
  checkedAt: z.number().int().nonnegative(),
  latestVersion: z.string(),
  releaseUrl: z.url(),
});

const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)$/;

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const UPDATE_CHECK_TIMEOUT_MS = 1_000;

export type UpdateNotice = Readonly<{
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}>;

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type UpdateCheckOptions = Readonly<{
  currentVersion: string;
  cacheDirectory: string;
  fetch?: Fetch;
  now?: () => number;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
  writeFile?: (path: string, contents: string) => Promise<void>;
  mkdir?: (path: string, options: { recursive: true }) => Promise<unknown>;
}>;

const parseVersion = (
  value: string,
): readonly [number, number, number] | null => {
  const match = versionPattern.exec(value);
  if (!match) return null;
  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  return major && minor && patch
    ? [Number(major), Number(minor), Number(patch)]
    : null;
};

const isNewerVersion = (candidate: string, current: string): boolean => {
  const candidateParts = parseVersion(candidate);
  const currentParts = parseVersion(current);
  if (!candidateParts || !currentParts) return false;
  for (let index = 0; index < candidateParts.length; index += 1) {
    const candidatePart = candidateParts[index];
    const currentPart = currentParts[index];
    if (candidatePart === undefined || currentPart === undefined) return false;
    if (candidatePart !== currentPart) return candidatePart > currentPart;
  }
  return false;
};

const noticeFrom = (
  currentVersion: string,
  latestVersion: string,
  releaseUrl: string,
): UpdateNotice | undefined =>
  isNewerVersion(latestVersion, currentVersion)
    ? { currentVersion, latestVersion, releaseUrl }
    : undefined;

export const checkForUpdate = async (
  options: UpdateCheckOptions,
): Promise<UpdateNotice | undefined> => {
  const cachePath = join(options.cacheDirectory, "update-check.json");
  const now = options.now ?? Date.now;
  const read = options.readFile ?? readFile;
  const write = options.writeFile ?? writeFile;
  const makeDirectory = options.mkdir ?? mkdir;

  try {
    const cached = updateCacheSchema.safeParse(
      JSON.parse(await read(cachePath, "utf8")),
    );
    if (
      cached.success &&
      now() - cached.data.checkedAt < UPDATE_CHECK_INTERVAL_MS
    ) {
      return noticeFrom(
        options.currentVersion,
        cached.data.latestVersion,
        cached.data.releaseUrl,
      );
    }
  } catch {
    // A missing or invalid cache simply triggers a fresh check.
  }

  try {
    const response = await (options.fetch ?? fetch)(
      "https://api.github.com/repos/danielsitek/asana-cli/releases/latest",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `asana-cli/${options.currentVersion}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
      },
    );
    if (!response.ok) return undefined;

    const release = latestReleaseSchema.safeParse(await response.json());
    if (!release.success) return undefined;
    const latestVersion = release.data.tag_name.replace(/^v/, "");
    if (!parseVersion(latestVersion)) return undefined;

    try {
      await makeDirectory(options.cacheDirectory, { recursive: true });
      await write(
        cachePath,
        `${JSON.stringify({
          checkedAt: now(),
          latestVersion,
          releaseUrl: release.data.html_url,
        })}\n`,
      );
    } catch {
      // Cache failures must not affect the command or a successful check.
    }

    return noticeFrom(
      options.currentVersion,
      latestVersion,
      release.data.html_url,
    );
  } catch {
    return undefined;
  }
};

export const renderUpdateNotice = (notice: UpdateNotice): string =>
  `\nUpdate available: ${notice.currentVersion} → ${notice.latestVersion}\n` +
  `Run \`brew upgrade asana-cli\` or visit ${notice.releaseUrl}\n`;

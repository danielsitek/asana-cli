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

type CachedUpdate = z.infer<typeof updateCacheSchema>;
type AvailableRelease = Omit<CachedUpdate, "checkedAt">;

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

type UpdateCheckDependencies = Readonly<{
  cachePath: string;
  now: () => number;
  read: (path: string, encoding: "utf8") => Promise<string>;
  write: (path: string, contents: string) => Promise<void>;
  makeDirectory: (
    path: string,
    options: { recursive: true },
  ) => Promise<unknown>;
  request: Fetch;
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

const readFreshCache = async (
  cachePath: string,
  now: () => number,
  read: (path: string, encoding: "utf8") => Promise<string>,
): Promise<CachedUpdate | undefined> => {
  try {
    const cached = updateCacheSchema.safeParse(
      JSON.parse(await read(cachePath, "utf8")),
    );
    if (!cached.success) return undefined;
    return now() - cached.data.checkedAt < UPDATE_CHECK_INTERVAL_MS
      ? cached.data
      : undefined;
  } catch {
    return undefined;
  }
};

const fetchLatestRelease = async (
  currentVersion: string,
  request: Fetch,
): Promise<AvailableRelease | undefined> => {
  try {
    const response = await request(
      "https://api.github.com/repos/danielsitek/asana-cli/releases/latest",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `asana-cli/${currentVersion}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
      },
    );
    if (!response.ok) return undefined;

    const release = latestReleaseSchema.safeParse(await response.json());
    if (!release.success) return undefined;
    const latestVersion = release.data.tag_name.replace(/^v/, "");
    return parseVersion(latestVersion)
      ? { latestVersion, releaseUrl: release.data.html_url }
      : undefined;
  } catch {
    return undefined;
  }
};

const writeCache = async (
  cachePath: string,
  cacheDirectory: string,
  update: CachedUpdate,
  makeDirectory: (
    path: string,
    options: { recursive: true },
  ) => Promise<unknown>,
  write: (path: string, contents: string) => Promise<void>,
): Promise<void> => {
  try {
    await makeDirectory(cacheDirectory, { recursive: true });
    await write(cachePath, `${JSON.stringify(update)}\n`);
  } catch {
    // Cache failures must not affect the command or a successful check.
  }
};

const resolveRequest = (request: Fetch | undefined): Fetch => request ?? fetch;

const resolveDependencies = (
  options: UpdateCheckOptions,
): UpdateCheckDependencies => ({
  cachePath: join(options.cacheDirectory, "update-check.json"),
  now: options.now ?? Date.now,
  read: options.readFile ?? readFile,
  write: options.writeFile ?? writeFile,
  makeDirectory: options.mkdir ?? mkdir,
  request: resolveRequest(options.fetch),
});

export const checkForUpdate = async (
  options: UpdateCheckOptions,
): Promise<UpdateNotice | undefined> => {
  const dependencies = resolveDependencies(options);

  const cached = await readFreshCache(
    dependencies.cachePath,
    dependencies.now,
    dependencies.read,
  );
  if (cached) {
    return noticeFrom(
      options.currentVersion,
      cached.latestVersion,
      cached.releaseUrl,
    );
  }

  const release = await fetchLatestRelease(
    options.currentVersion,
    dependencies.request,
  );
  if (!release) return undefined;

  await writeCache(
    dependencies.cachePath,
    options.cacheDirectory,
    { checkedAt: dependencies.now(), ...release },
    dependencies.makeDirectory,
    dependencies.write,
  );
  return noticeFrom(
    options.currentVersion,
    release.latestVersion,
    release.releaseUrl,
  );
};

export const renderUpdateNotice = (notice: UpdateNotice): string =>
  `\nUpdate available: ${notice.currentVersion} → ${notice.latestVersion}\n` +
  `Run \`brew upgrade asana-cli\` or visit ${notice.releaseUrl}\n`;

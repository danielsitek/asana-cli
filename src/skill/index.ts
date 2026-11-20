import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { version } from "../../package.json";
import bundledSkill from "../../skills/asana-cli/SKILL.md" with { type: "text" };

import { err, ok, type Result } from "../shared/result.ts";

export const SKILL_AGENTS = [
  {
    name: "claude-code",
    localDirectory: ".claude/skills",
    globalDirectory: ".claude/skills",
  },
  {
    name: "codex",
    localDirectory: ".agents/skills",
    globalDirectory: ".agents/skills",
  },
  {
    name: "copilot",
    localDirectory: ".github/skills",
    globalDirectory: ".copilot/skills",
  },
  {
    name: "cursor",
    localDirectory: ".cursor/skills",
    globalDirectory: ".cursor/skills",
  },
  {
    name: "gemini",
    localDirectory: ".gemini/skills",
    globalDirectory: ".gemini/skills",
  },
  {
    name: "pi",
    localDirectory: ".pi/skills",
    globalDirectory: ".pi/agent/skills",
  },
  {
    name: "universal",
    localDirectory: ".agents/skills",
    globalDirectory: ".agents/skills",
  },
] as const;

export type SkillAgent = (typeof SKILL_AGENTS)[number]["name"];
export type SkillScope = "global" | "local";

export type SkillContext = Readonly<{
  cwd: string;
  home: string;
}>;

export type SkillError = Readonly<{
  kind:
    | "unknown_agent"
    | "already_installed"
    | "not_installed"
    | "foreign"
    | "newer"
    | "filesystem";
  message: string;
  completed?: readonly SkillMutation[];
}>;

type InstallationState =
  | "absent"
  | "current"
  | "outdated"
  | "newer"
  | "foreign";

export type SkillInstallationStatus = Readonly<{
  path: string;
  status: InstallationState;
}>;

export type SkillAgentStatus = Readonly<{
  agent: SkillAgent;
  global: SkillInstallationStatus;
  local: SkillInstallationStatus;
}>;

export type SkillMutation = Readonly<{
  agent: SkillAgent;
  scope: SkillScope;
  path: string;
  action: "installed" | "updated" | "uninstalled";
}>;

export type SkillUpdateAllResult = Readonly<{
  updated: readonly SkillMutation[];
  skipped: readonly Readonly<{
    agent: SkillAgent;
    scope: SkillScope;
    path: string;
    reason: "not_installed" | "foreign" | "newer";
  }>[];
}>;

const scopeRoot = (context: SkillContext, scope: SkillScope): string =>
  scope === "local" ? context.cwd : context.home;

const requireAgent = (
  agent: string,
): Result<(typeof SKILL_AGENTS)[number], SkillError> => {
  const entry = SKILL_AGENTS.find((entry) => entry.name === agent);
  return entry
    ? ok(entry)
    : err({
        kind: "unknown_agent",
        message: `Unknown skill agent: ${agent}; expected ${SKILL_AGENTS.map(({ name }) => name).join(", ")}`,
      });
};

const targetPath = (
  context: SkillContext,
  entry: (typeof SKILL_AGENTS)[number],
  scope: SkillScope,
): string =>
  join(
    scopeRoot(context, scope),
    scope === "local" ? entry.localDirectory : entry.globalDirectory,
    "asana-cli",
    "SKILL.md",
  );

const digest = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const bundledDigest = digest(bundledSkill);
const installationContents = `${bundledSkill}
<!-- asana-cli managed: ${version} sha256:${bundledDigest} -->
`;
const ownershipStamp =
  /\n<!-- asana-cli managed: (\S+) sha256:([a-f0-9]{64}) -->\n$/;

const ownedFileStatus = (contents: string): InstallationState => {
  const stamp = ownershipStamp.exec(contents);
  if (
    !stamp?.[1] ||
    stamp.index + stamp[0].length !== contents.length ||
    stamp[2] !== digest(contents.slice(0, stamp.index))
  ) {
    return "foreign";
  }
  try {
    const order = Bun.semver.order(stamp[1], version);
    if (order > 0) return "newer";
    return order === 0 && stamp[2] === bundledDigest ? "current" : "outdated";
  } catch {
    return "foreign";
  }
};

const filesystemError = (action: string, path: string): SkillError => ({
  kind: "filesystem",
  message: `Unable to ${action} the asana-cli skill at ${path}`,
});

const refused = (kind: "foreign" | "newer", path: string): SkillError => ({
  kind,
  message: `The asana-cli skill at ${path} is ${kind}; use --force to proceed`,
});

const hasCode = (error: unknown, ...codes: string[]): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  codes.includes(error.code);

// The caller supplies the project or home root. Inspect every directory below
// it so links above the skill directory also require explicit consent.
const hasLinkedDirectory = async (
  root: string,
  path: string,
): Promise<boolean> => {
  let directory = root;
  for (const component of relative(root, dirname(path)).split(sep)) {
    directory = join(directory, component);
    try {
      if ((await lstat(directory)).isSymbolicLink()) return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
  }
  return false;
};

const inspectInstallation = async (
  root: string,
  path: string,
  force: boolean,
): Promise<Result<InstallationState, SkillError>> => {
  try {
    if (!force && (await hasLinkedDirectory(root, path))) return ok("foreign");
    const file = await lstat(path);
    if (file.isSymbolicLink()) return ok("foreign");
    if (!file.isFile()) {
      return force ? err(filesystemError("inspect", path)) : ok("foreign");
    }
    return ok(
      force ? "foreign" : ownedFileStatus(await readFile(path, "utf8")),
    );
  } catch (error) {
    return hasCode(error, "ENOENT")
      ? ok("absent")
      : err(filesystemError("inspect", path));
  }
};

const resolveDirectory = async (
  root: string,
  path: string,
  force: boolean,
): Promise<Result<{ directory: string; linked: boolean }, SkillError>> => {
  try {
    const logicalDirectory = dirname(path);
    const absoluteRoot = await realpath(root);
    const directory = await realpath(logicalDirectory);
    const linked =
      directory !== join(absoluteRoot, relative(root, logicalDirectory));
    return linked && !force
      ? err(refused("foreign", path))
      : ok({ directory, linked });
  } catch {
    return err(filesystemError("locate", path));
  }
};

const replaceFile = async (
  root: string,
  path: string,
  force: boolean,
  overwrite: boolean,
): Promise<Result<void, SkillError>> => {
  const resolved = await resolveDirectory(root, path, force);
  if (!resolved.ok) return resolved;
  const destination = join(resolved.value.directory, "SKILL.md");
  const temporaryPath = `${destination}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, installationContents, { flag: "wx" });
    if (overwrite) {
      await rename(temporaryPath, destination);
    } else {
      await link(temporaryPath, destination);
    }
    return ok(undefined);
  } catch (error) {
    if (!overwrite && hasCode(error, "EEXIST")) {
      return err({
        kind: "already_installed",
        message:
          "The asana-cli skill is already installed; use --force to replace it",
      });
    }
    return err(filesystemError("write", path));
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

export const bundledInstallationContents = (): string => installationContents;

export const listSkillInstallations = async (
  context: SkillContext,
): Promise<Result<readonly SkillAgentStatus[], SkillError>> => {
  const statuses: SkillAgentStatus[] = [];
  for (const entry of SKILL_AGENTS) {
    const globalPath = targetPath(context, entry, "global");
    const global = await inspectInstallation(context.home, globalPath, false);
    if (!global.ok) return global;
    const localPath = targetPath(context, entry, "local");
    const local = await inspectInstallation(context.cwd, localPath, false);
    if (!local.ok) return local;
    statuses.push({
      agent: entry.name,
      global: { path: globalPath, status: global.value },
      local: { path: localPath, status: local.value },
    });
  }
  return ok(statuses);
};

export const installSkill = async (
  context: SkillContext,
  agent: string,
  scope: SkillScope,
  force = false,
): Promise<Result<SkillMutation, SkillError>> => {
  const entry = requireAgent(agent);
  if (!entry.ok) return entry;
  const path = targetPath(context, entry.value, scope);
  try {
    if (!force && (await hasLinkedDirectory(scopeRoot(context, scope), path))) {
      return err(refused("foreign", path));
    }
    await mkdir(dirname(path), { recursive: true });
  } catch {
    return err(filesystemError("install", path));
  }
  const written = await replaceFile(
    scopeRoot(context, scope),
    path,
    force,
    force,
  );
  return written.ok
    ? ok({ agent: entry.value.name, scope, path, action: "installed" })
    : written;
};

const withInstalledTarget = async (
  context: SkillContext,
  agent: string,
  scope: SkillScope,
  force: boolean,
  action: "updated" | "uninstalled",
  mutate: (mutation: SkillMutation) => Promise<Result<void, SkillError>>,
): Promise<Result<SkillMutation, SkillError>> => {
  const entry = requireAgent(agent);
  if (!entry.ok) return entry;
  const path = targetPath(context, entry.value, scope);
  const installed = await inspectInstallation(
    scopeRoot(context, scope),
    path,
    force,
  );
  if (!installed.ok) return installed;
  if (installed.value === "absent") {
    return err({
      kind: "not_installed",
      message: `The asana-cli skill is not installed for ${entry.value.name} (${scope})`,
    });
  }
  if (
    !force &&
    (installed.value === "foreign" ||
      (installed.value === "newer" && action === "updated"))
  ) {
    return err(refused(installed.value, path));
  }

  const mutation = { agent: entry.value.name, scope, path, action };
  const result = await mutate(mutation);
  return result.ok ? ok(mutation) : result;
};

export const updateSkill = async (
  context: SkillContext,
  agent: string,
  scope: SkillScope,
  force = false,
): Promise<Result<SkillMutation, SkillError>> =>
  withInstalledTarget(context, agent, scope, force, "updated", ({ path }) =>
    replaceFile(scopeRoot(context, scope), path, force, true),
  );

export const updateAllSkills = async (
  context: SkillContext,
  scope: SkillScope,
  force = false,
): Promise<Result<SkillUpdateAllResult, SkillError>> => {
  const root = scopeRoot(context, scope);
  const targets = new Map<string, SkillAgent[]>();
  for (const entry of SKILL_AGENTS) {
    const path = targetPath(context, entry, scope);
    targets.set(path, [...(targets.get(path) ?? []), entry.name]);
  }

  const updated: SkillMutation[] = [];
  const skipped: SkillUpdateAllResult["skipped"][number][] = [];
  for (const [path, agents] of targets) {
    const installed = await inspectInstallation(root, path, force);
    if (!installed.ok) {
      return updated.length
        ? err({ ...installed.error, completed: updated })
        : installed;
    }
    const state = installed.value;
    if (
      state === "absent" ||
      (!force && (state === "foreign" || state === "newer"))
    ) {
      for (const agent of agents) {
        skipped.push({
          agent,
          scope,
          path,
          reason: state === "absent" ? "not_installed" : state,
        });
      }
      continue;
    }
    const written = await replaceFile(root, path, force, true);
    if (!written.ok) {
      return updated.length
        ? err({ ...written.error, completed: updated })
        : written;
    }
    for (const agent of agents) {
      updated.push({ agent, scope, path, action: "updated" });
    }
  }
  return ok({ updated, skipped });
};

export const uninstallSkill = async (
  context: SkillContext,
  agent: string,
  scope: SkillScope,
  force = false,
): Promise<Result<SkillMutation, SkillError>> =>
  withInstalledTarget(
    context,
    agent,
    scope,
    force,
    "uninstalled",
    async (mutation) => {
      const { path } = mutation;
      const resolved = await resolveDirectory(
        scopeRoot(context, scope),
        path,
        force,
      );
      if (!resolved.ok) return resolved;
      const { directory, linked } = resolved.value;
      try {
        await unlink(join(directory, "SKILL.md"));
      } catch {
        return err(filesystemError("uninstall", path));
      }
      if (linked) return ok(undefined);
      try {
        await rmdir(directory);
        return ok(undefined);
      } catch (error) {
        return hasCode(error, "ENOTEMPTY", "EEXIST", "ENOENT")
          ? ok(undefined)
          : err({
              ...filesystemError("remove the empty directory for", path),
              completed: [mutation],
            });
      }
    },
  );

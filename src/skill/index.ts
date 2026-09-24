import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

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
  kind: "unknown_agent" | "already_installed" | "not_installed" | "filesystem";
  message: string;
}>;

export type SkillInstallationStatus = Readonly<{
  path: string;
  status: "absent" | "current" | "outdated";
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
    reason: "not_installed";
  }>[];
}>;

const registryEntry = (agent: string) =>
  SKILL_AGENTS.find((entry) => entry.name === agent);

const requireAgent = (
  agent: string,
): Result<(typeof SKILL_AGENTS)[number], SkillError> => {
  const entry = registryEntry(agent);
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
    scope === "local" ? context.cwd : context.home,
    scope === "local" ? entry.localDirectory : entry.globalDirectory,
    "asana-cli",
    "SKILL.md",
  );

const filesystemError = (action: string): SkillError => ({
  kind: "filesystem",
  message: `Unable to ${action} the asana-cli skill`,
});

const readInstalled = async (
  path: string,
): Promise<Result<string | undefined, SkillError>> => {
  try {
    return ok(await readFile(path, "utf8"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return ok(undefined);
    }
    return err(filesystemError("inspect"));
  }
};

const installationStatus = async (
  path: string,
): Promise<Result<SkillInstallationStatus, SkillError>> => {
  const installed = await readInstalled(path);
  return installed.ok
    ? ok({
        path,
        status:
          installed.value === undefined
            ? "absent"
            : installed.value === bundledSkill
              ? "current"
              : "outdated",
      })
    : installed;
};

const replaceFile = async (
  path: string,
  content: string,
): Promise<Result<void, SkillError>> => {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, content, { flag: "wx" });
    await rename(temporaryPath, path);
    return ok(undefined);
  } catch {
    return err(filesystemError("write"));
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const writeInstallation = async (
  path: string,
  force: boolean,
): Promise<Result<void, SkillError>> => {
  try {
    await mkdir(dirname(path), { recursive: true });
    if (force) return replaceFile(path, bundledSkill);
    await writeFile(path, bundledSkill, { flag: "wx" });
    return ok(undefined);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return err({
        kind: "already_installed",
        message:
          "The asana-cli skill is already installed; use --force to replace it",
      });
    }
    return err(filesystemError("install"));
  }
};

export const bundledSkillContents = (): string => bundledSkill;

export const listSkillInstallations = async (
  context: SkillContext,
): Promise<Result<readonly SkillAgentStatus[], SkillError>> => {
  const statuses: SkillAgentStatus[] = [];
  for (const entry of SKILL_AGENTS) {
    const global = await installationStatus(
      targetPath(context, entry, "global"),
    );
    if (!global.ok) return global;
    const local = await installationStatus(targetPath(context, entry, "local"));
    if (!local.ok) return local;
    statuses.push({
      agent: entry.name,
      global: global.value,
      local: local.value,
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
  const written = await writeInstallation(path, force);
  return written.ok
    ? ok({ agent: entry.value.name, scope, path, action: "installed" })
    : written;
};

export const updateSkill = async (
  context: SkillContext,
  agent: string,
  scope: SkillScope,
): Promise<Result<SkillMutation, SkillError>> => {
  const entry = requireAgent(agent);
  if (!entry.ok) return entry;
  const path = targetPath(context, entry.value, scope);
  const installed = await readInstalled(path);
  if (!installed.ok) return installed;
  if (installed.value === undefined) {
    return err({
      kind: "not_installed",
      message: `The asana-cli skill is not installed for ${entry.value.name} (${scope})`,
    });
  }
  const written = await replaceFile(path, bundledSkill);
  return written.ok
    ? ok({ agent: entry.value.name, scope, path, action: "updated" })
    : written;
};

export const updateAllSkills = async (
  context: SkillContext,
  scope: SkillScope,
): Promise<Result<SkillUpdateAllResult, SkillError>> => {
  const targets = new Map<string, (typeof SKILL_AGENTS)[number][]>();
  for (const entry of SKILL_AGENTS) {
    const path = targetPath(context, entry, scope);
    targets.set(path, [...(targets.get(path) ?? []), entry]);
  }

  const updated: SkillMutation[] = [];
  const skipped: SkillUpdateAllResult["skipped"][number][] = [];
  for (const [path, entries] of targets) {
    const installed = await readInstalled(path);
    if (!installed.ok) return installed;
    if (installed.value === undefined) {
      entries.forEach((entry) =>
        skipped.push({
          agent: entry.name,
          scope,
          path,
          reason: "not_installed",
        }),
      );
      continue;
    }
    const written = await replaceFile(path, bundledSkill);
    if (!written.ok) return written;
    entries.forEach((entry) =>
      updated.push({ agent: entry.name, scope, path, action: "updated" }),
    );
  }
  return ok({ updated, skipped });
};

export const uninstallSkill = async (
  context: SkillContext,
  agent: string,
  scope: SkillScope,
): Promise<Result<SkillMutation, SkillError>> => {
  const entry = requireAgent(agent);
  if (!entry.ok) return entry;
  const path = targetPath(context, entry.value, scope);
  const installed = await readInstalled(path);
  if (!installed.ok) return installed;
  if (installed.value === undefined) {
    return err({
      kind: "not_installed",
      message: `The asana-cli skill is not installed for ${entry.value.name} (${scope})`,
    });
  }
  try {
    await rm(path);
    await rmdir(dirname(path)).catch((error: unknown) => {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error.code !== "ENOTEMPTY" && error.code !== "ENOENT")
      ) {
        throw error;
      }
    });
    return ok({ agent: entry.value.name, scope, path, action: "uninstalled" });
  } catch {
    return err(filesystemError("uninstall"));
  }
};

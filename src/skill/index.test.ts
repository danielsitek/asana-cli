import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bundledSkillContents,
  installSkill,
  listSkillInstallations,
  SKILL_AGENTS,
  uninstallSkill,
  updateAllSkills,
  updateSkill,
  type SkillContext,
} from "./index.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const createContext = async (): Promise<SkillContext> => {
  const root = await mkdtemp(join(tmpdir(), "asana-cli-skill-test-"));
  directories.push(root);
  return { cwd: join(root, "project"), home: join(root, "home") };
};

const localUniversalPath = (context: SkillContext): string =>
  join(context.cwd, ".agents", "skills", "asana-cli", "SKILL.md");

const globalClaudePath = (context: SkillContext): string =>
  join(context.home, ".claude", "skills", "asana-cli", "SKILL.md");

describe("bundled skill registry", () => {
  test("uses the documented agent skill directories", () => {
    expect(SKILL_AGENTS).toEqual([
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
    ]);
  });

  test("reports absent, current, and outdated installations", async () => {
    const context = await createContext();
    const installed = await installSkill(context, "claude-code", "global");
    expect(installed.ok).toBe(true);

    const outdatedPath = join(
      context.cwd,
      ".cursor",
      "skills",
      "asana-cli",
      "SKILL.md",
    );
    await mkdir(join(outdatedPath, ".."), { recursive: true });
    await writeFile(outdatedPath, "old skill\n");

    const listed = await listSkillInstallations(context);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    expect(listed.value.find(({ agent }) => agent === "claude-code")).toEqual({
      agent: "claude-code",
      global: { path: globalClaudePath(context), status: "current" },
      local: {
        path: join(context.cwd, ".claude", "skills", "asana-cli", "SKILL.md"),
        status: "absent",
      },
    });
    expect(
      listed.value.find(({ agent }) => agent === "cursor")?.local.status,
    ).toBe("outdated");
  });
});

describe("bundled skill mutations", () => {
  test("installs the canonical skill globally and locally", async () => {
    const context = await createContext();

    const global = await installSkill(context, "claude-code", "global");
    const local = await installSkill(context, "universal", "local");

    expect(global).toEqual({
      ok: true,
      value: {
        agent: "claude-code",
        scope: "global",
        path: globalClaudePath(context),
        action: "installed",
      },
    });
    expect(local).toEqual({
      ok: true,
      value: {
        agent: "universal",
        scope: "local",
        path: localUniversalPath(context),
        action: "installed",
      },
    });
    expect(await readFile(globalClaudePath(context), "utf8")).toBe(
      bundledSkillContents(),
    );
    expect(await readFile(localUniversalPath(context), "utf8")).toBe(
      bundledSkillContents(),
    );
  });

  test("protects an existing file unless force is explicit", async () => {
    const context = await createContext();
    const path = localUniversalPath(context);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "custom skill\n");

    const protectedResult = await installSkill(context, "universal", "local");
    expect(protectedResult).toMatchObject({
      ok: false,
      error: { kind: "already_installed" },
    });
    expect(await readFile(path, "utf8")).toBe("custom skill\n");

    const forced = await installSkill(context, "universal", "local", true);
    expect(forced.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe(bundledSkillContents());
  });

  test("updates one installed target and rejects an absent target", async () => {
    const context = await createContext();
    const path = globalClaudePath(context);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "old skill\n");

    const updated = await updateSkill(context, "claude-code", "global");
    expect(updated).toMatchObject({
      ok: true,
      value: { action: "updated", agent: "claude-code", scope: "global" },
    });
    expect(await readFile(path, "utf8")).toBe(bundledSkillContents());

    const absent = await updateSkill(context, "cursor", "global");
    expect(absent).toMatchObject({
      ok: false,
      error: { kind: "not_installed" },
    });
  });

  test("updates installed targets and skips absent targets for all", async () => {
    const context = await createContext();
    const universalPath = localUniversalPath(context);
    const geminiPath = join(
      context.cwd,
      ".gemini",
      "skills",
      "asana-cli",
      "SKILL.md",
    );
    for (const path of [universalPath, geminiPath]) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "old skill\n");
    }

    const result = await updateAllSkills(context, "local");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.updated.map(({ agent }) => agent)).toEqual([
      "codex",
      "universal",
      "gemini",
    ]);
    expect(result.value.skipped).toHaveLength(4);
    expect(await readFile(universalPath, "utf8")).toBe(bundledSkillContents());
    expect(await readFile(geminiPath, "utf8")).toBe(bundledSkillContents());
  });

  test("uninstalls only the managed file and empty skill directory", async () => {
    const context = await createContext();
    const path = localUniversalPath(context);
    await installSkill(context, "universal", "local");

    const removed = await uninstallSkill(context, "universal", "local");
    expect(removed.ok).toBe(true);
    expect(await Bun.file(path).exists()).toBe(false);
    expect(
      (await stat(join(context.cwd, ".agents", "skills"))).isDirectory(),
    ).toBe(true);
    expect(
      await Bun.file(
        join(context.cwd, ".agents", "skills", "asana-cli"),
      ).exists(),
    ).toBe(false);
  });

  test("keeps a non-empty skill directory during uninstall", async () => {
    const context = await createContext();
    const path = localUniversalPath(context);
    await installSkill(context, "universal", "local");
    await writeFile(join(path, "..", "notes.md"), "keep\n");

    const removed = await uninstallSkill(context, "universal", "local");
    expect(removed.ok).toBe(true);
    expect(await readFile(join(path, "..", "notes.md"), "utf8")).toBe("keep\n");
  });

  test("rejects unknown agents without creating paths", async () => {
    const context = await createContext();
    const result = await installSkill(context, "unknown", "local");

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "unknown_agent" },
    });
    expect(await Bun.file(context.cwd).exists()).toBe(false);
  });
});

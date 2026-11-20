import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  bundledInstallationContents,
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

const writeSkill = async (path: string, contents: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
};

const stamped = (version: string, body = "other skill\n"): string =>
  `${body}\n<!-- asana-cli managed: ${version} sha256:${createHash("sha256").update(body).digest("hex")} -->\n`;

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

  test("distinguishes absent, current, outdated, newer, and foreign installations", async () => {
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
    await writeSkill(outdatedPath, stamped("0.1.0"));
    await writeSkill(localUniversalPath(context), stamped("99.0.0"));
    await writeSkill(
      join(context.cwd, ".gemini", "skills", "asana-cli", "SKILL.md"),
      "local changes\n" + bundledInstallationContents(),
    );

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
    expect(
      listed.value.find(({ agent }) => agent === "universal")?.local.status,
    ).toBe("newer");
    expect(
      listed.value.find(({ agent }) => agent === "gemini")?.local.status,
    ).toBe("foreign");
  });
});

describe("bundled skill mutations", () => {
  test("installs a stamped copy globally and locally", async () => {
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
      bundledInstallationContents(),
    );
    expect(await readFile(localUniversalPath(context), "utf8")).toBe(
      bundledInstallationContents(),
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
    expect(await readFile(path, "utf8")).toBe(bundledInstallationContents());
  });

  test("updates one installed target and rejects an absent target", async () => {
    const context = await createContext();
    const path = globalClaudePath(context);
    await writeSkill(path, stamped("0.1.0"));

    const updated = await updateSkill(context, "claude-code", "global");
    expect(updated).toMatchObject({
      ok: true,
      value: { action: "updated", agent: "claude-code", scope: "global" },
    });
    expect(await readFile(path, "utf8")).toBe(bundledInstallationContents());

    const absent = await updateSkill(context, "cursor", "global");
    expect(absent).toMatchObject({
      ok: false,
      error: { kind: "not_installed" },
    });
  });

  test("preserves target errors for update and uninstall", async () => {
    const context = await createContext();
    for (const operation of [updateSkill, uninstallSkill]) {
      expect(await operation(context, "cursor", "global")).toEqual({
        ok: false,
        error: {
          kind: "not_installed",
          message: "The asana-cli skill is not installed for cursor (global)",
        },
      });
      expect(await operation(context, "unknown", "local")).toMatchObject({
        ok: false,
        error: { kind: "unknown_agent" },
      });
    }
  });

  test("updates owned targets and reports why other targets were skipped", async () => {
    const context = await createContext();
    const universalPath = localUniversalPath(context);
    const geminiPath = join(
      context.cwd,
      ".gemini",
      "skills",
      "asana-cli",
      "SKILL.md",
    );
    const claudePath = join(
      context.cwd,
      ".claude",
      "skills",
      "asana-cli",
      "SKILL.md",
    );
    const foreignContents = "local changes\n";
    const newerContents = stamped("99.0.0");
    await writeSkill(universalPath, stamped("0.1.0"));
    await writeSkill(geminiPath, foreignContents);
    await writeSkill(claudePath, newerContents);

    const result = await updateAllSkills(context, "local");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.updated.map(({ agent }) => agent)).toEqual([
      "codex",
      "universal",
    ]);
    expect(result.value.skipped.map(({ reason }) => reason)).toEqual([
      "newer",
      "not_installed",
      "not_installed",
      "foreign",
      "not_installed",
    ]);
    expect(await readFile(universalPath, "utf8")).toBe(
      bundledInstallationContents(),
    );
    expect(await readFile(geminiPath, "utf8")).toBe(foreignContents);
    expect(await readFile(claudePath, "utf8")).toBe(newerContents);
    expect(await updateSkill(context, "claude-code", "local")).toMatchObject({
      ok: false,
      error: { kind: "newer" },
    });
    expect(await updateAllSkills(context, "local", true)).toMatchObject({
      ok: true,
      value: {
        updated: expect.arrayContaining([
          expect.objectContaining({ agent: "claude-code" }),
          expect.objectContaining({ agent: "gemini" }),
        ]),
      },
    });
    expect(await readFile(geminiPath, "utf8")).toBe(
      bundledInstallationContents(),
    );
    expect(await readFile(claudePath, "utf8")).toBe(
      bundledInstallationContents(),
    );
  });

  test.each(["skill directory", "ancestor directory", "skill file"])(
    "protects the target of a symlinked %s",
    async (linked) => {
      const context = await createContext();
      const path = localUniversalPath(context);
      const checkout = join(context.cwd, "checkout");
      const linkPath =
        linked === "skill file"
          ? path
          : linked === "skill directory"
            ? dirname(path)
            : dirname(dirname(path));
      const targetPath =
        linked === "ancestor directory"
          ? join(checkout, "asana-cli", "SKILL.md")
          : join(checkout, "SKILL.md");
      // A valid stamp must not make a symlink eligible for mutation.
      const contents = bundledInstallationContents();
      await writeSkill(targetPath, contents);
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(linked === "skill file" ? targetPath : checkout, linkPath);

      expect(await listSkillInstallations(context)).toMatchObject({
        ok: true,
        value: expect.arrayContaining([
          expect.objectContaining({
            agent: "universal",
            local: { path, status: "foreign" },
          }),
        ]),
      });
      for (const operation of [updateSkill, uninstallSkill]) {
        expect(await operation(context, "universal", "local")).toMatchObject({
          ok: false,
          error: { kind: "foreign" },
        });
      }
      expect(await updateAllSkills(context, "local")).toMatchObject({
        ok: true,
        value: {
          updated: [],
          skipped: expect.arrayContaining([
            expect.objectContaining({ agent: "universal", reason: "foreign" }),
          ]),
        },
      });
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(targetPath, "utf8")).toBe(contents);
    },
  );

  test("handles dangling file symlinks without following them", async () => {
    const context = await createContext();
    const path = localUniversalPath(context);
    const missing = join(context.cwd, "missing.md");
    await mkdir(dirname(path), { recursive: true });
    await symlink(missing, path);

    expect(await updateSkill(context, "universal", "local")).toMatchObject({
      ok: false,
      error: { kind: "foreign" },
    });
    expect((await updateSkill(context, "universal", "local", true)).ok).toBe(
      true,
    );
    expect((await lstat(path)).isFile()).toBe(true);
    await rm(path);
    await symlink(missing, path);
    expect((await uninstallSkill(context, "universal", "local", true)).ok).toBe(
      true,
    );
    expect(await Bun.file(missing).exists()).toBe(false);
  });

  test("only changes the skill file when forcing a linked directory", async () => {
    const context = await createContext();
    const path = localUniversalPath(context);
    const checkout = join(context.cwd, "checkout");
    const file = join(checkout, "SKILL.md");
    await writeSkill(file, "custom skill\n");
    await mkdir(dirname(dirname(path)), { recursive: true });
    await symlink(checkout, dirname(path));

    expect((await updateSkill(context, "universal", "local", true)).ok).toBe(
      true,
    );
    expect(await readFile(file, "utf8")).toBe(bundledInstallationContents());
    expect((await uninstallSkill(context, "universal", "local", true)).ok).toBe(
      true,
    );
    expect((await lstat(dirname(path))).isSymbolicLink()).toBe(true);
    expect((await stat(checkout)).isDirectory()).toBe(true);
    expect(await Bun.file(file).exists()).toBe(false);
  });

  test.skipIf(process.getuid?.() === 0)(
    "reports the removed file when directory cleanup fails",
    async () => {
      const context = await createContext();
      const path = localUniversalPath(context);
      await installSkill(context, "universal", "local");
      const parent = dirname(dirname(path));
      await chmod(parent, 0o555);
      try {
        expect(
          await uninstallSkill(context, "universal", "local"),
        ).toMatchObject({
          ok: false,
          error: {
            kind: "filesystem",
            completed: [
              {
                agent: "universal",
                scope: "local",
                path,
                action: "uninstalled",
              },
            ],
          },
        });
        expect(await Bun.file(path).exists()).toBe(false);
      } finally {
        await chmod(parent, 0o755);
      }
    },
  );

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

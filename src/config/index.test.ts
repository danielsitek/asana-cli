import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  getConfigValue,
  initializeSharedConfig,
  resolveConfig,
  setConfigValue,
  type ConfigContext,
} from "./index.ts";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "asana-cli-config-"));
  temporaryDirectories.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const context = (
  cwd: string,
  home: string,
  environment: Readonly<Record<string, string | undefined>> = {},
): ConfigContext => ({ cwd, home, environment });

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

describe("resolveConfig", () => {
  test("deep merges strict global, shared, and local sources", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const repository = join(root, "repository");
    const nested = join(repository, "src", "feature");
    await mkdir(join(home, ".config", "asana-cli"), { recursive: true });
    await mkdir(join(repository, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeJson(join(home, ".config", "asana-cli", "config.json"), {
      workspace: { gid: "100" },
      project: { gid: "200", sections: { todo: "201", done: "202" } },
      network: { concurrency: 2, maxRetries: 1 },
    });
    await writeJson(join(repository, ".asana-cli.json"), {
      workspace: { gid: "101" },
      project: { sections: { done: "203" } },
      network: { maxRetries: 2 },
    });
    await writeJson(join(repository, ".asana-cli.local.json"), {
      workspace: { gid: "102" },
      project: { sections: { todo: "204" } },
      network: { concurrency: 8 },
      myTasks: { sections: { review: "301" } },
    });

    const result = await resolveConfig(context(nested, home));

    expect(result).toEqual({
      ok: true,
      value: {
        value: {
          workspace: { gid: "102" },
          project: {
            gid: "200",
            sections: { todo: "204", done: "203" },
          },
          network: {
            concurrency: 8,
            maxRetries: 2,
            requestTimeoutMs: 30000,
          },
          myTasks: { sections: { review: "301" } },
        },
        sources: {
          "workspace.gid": {
            layer: "local",
            path: join(repository, ".asana-cli.local.json"),
          },
          "project.gid": {
            layer: "global",
            path: join(home, ".config", "asana-cli", "config.json"),
          },
          "project.sections.todo": {
            layer: "local",
            path: join(repository, ".asana-cli.local.json"),
          },
          "project.sections.done": {
            layer: "shared",
            path: join(repository, ".asana-cli.json"),
          },
          "myTasks.sections.review": {
            layer: "local",
            path: join(repository, ".asana-cli.local.json"),
          },
          "network.concurrency": {
            layer: "local",
            path: join(repository, ".asana-cli.local.json"),
          },
          "network.maxRetries": {
            layer: "shared",
            path: join(repository, ".asana-cli.json"),
          },
          "network.requestTimeoutMs": {
            layer: "built-in",
          },
        },
        paths: {
          global: join(home, ".config", "asana-cli", "config.json"),
          gitRoot: repository,
          shared: join(repository, ".asana-cli.json"),
          local: join(repository, ".asana-cli.local.json"),
        },
      },
    });
  });

  test("recognizes a worktree git file and the nearest repository", async () => {
    const root = await temporaryDirectory();
    const outer = join(root, "outer");
    const worktree = join(outer, "worktree");
    const nested = join(worktree, "nested");
    await mkdir(join(outer, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(join(worktree, ".git"), "gitdir: ../.git/worktrees/test\n");
    await writeJson(join(outer, ".asana-cli.json"), {
      workspace: { gid: "100" },
    });
    await writeJson(join(worktree, ".asana-cli.json"), {
      workspace: { gid: "200" },
    });

    const result = await resolveConfig(context(nested, join(root, "home")));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.paths.gitRoot).toBe(worktree);
      expect(result.value.value.workspace?.gid).toBe("200");
    }
  });

  test("uses XDG global config and skips project files outside git", async () => {
    const root = await temporaryDirectory();
    const xdg = join(root, "xdg");
    const cwd = join(root, "plain", "nested");
    await mkdir(join(xdg, "asana-cli"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeJson(join(xdg, "asana-cli", "config.json"), {
      workspace: { gid: "100" },
    });
    await writeJson(join(root, "plain", ".asana-cli.json"), {
      workspace: { gid: "999" },
    });

    const result = await resolveConfig(
      context(cwd, join(root, "home"), { XDG_CONFIG_HOME: xdg }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value.workspace?.gid).toBe("100");
      expect(result.value.paths.gitRoot).toBeUndefined();
      expect(result.value.value.network).toEqual({
        concurrency: 4,
        maxRetries: 3,
        requestTimeoutMs: 30000,
      });
      expect(result.value.sources["network.concurrency"]).toEqual({
        layer: "built-in",
      });
    }
  });

  test("reports invalid JSON, unknown keys, GIDs, secrets, and personal shared data", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["{", "invalid JSON"],
      ['{"workspace":{"gid":"100"},"secctions":{}}', "secctions"],
      ['{"workspace":{"gid":"abc"}}', "digit-only GID"],
      [
        '{"workspace":{"gid":"100"},"nested":{"apiToken":"secret"}}',
        "nested.apiToken is forbidden",
      ],
      ['{"workspace":{"gid":"100"},"myTasks":{"sections":{}}}', "myTasks"],
    ];
    for (const [contents, message] of cases) {
      const root = await temporaryDirectory();
      await mkdir(join(root, ".git"));
      await writeFile(join(root, ".asana-cli.json"), contents);
      const result = await resolveConfig(context(root, join(root, "home")));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain(".asana-cli.json");
        expect(result.error.message).toContain(message);
      }
    }
  });

  test("rejects deferred profile configuration in every file layer", async () => {
    for (const layer of ["global", "shared", "local"] as const) {
      const root = await temporaryDirectory();
      const home = join(root, "home");
      await mkdir(join(root, ".git"));
      const path =
        layer === "global"
          ? join(home, ".config", "asana-cli", "config.json")
          : join(
              root,
              layer === "shared" ? ".asana-cli.json" : ".asana-cli.local.json",
            );
      await mkdir(dirname(path), { recursive: true });
      await writeJson(path, { profile: "work" });

      const result = await resolveConfig(context(root, home));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain(path);
        expect(result.error.message).toContain("profile");
      }
    }
  });
});

describe("configuration writes", () => {
  test("initializes shared config and preserves existing fields", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      project: { gid: "200" },
    });

    const result = await initializeSharedConfig(
      context(root, join(root, "home")),
      "100",
    );

    expect(result.ok).toBe(true);
    expect(
      JSON.parse(await readFile(join(root, ".asana-cli.json"), "utf8")),
    ).toEqual({
      project: { gid: "200" },
      workspace: { gid: "100" },
    });
  });

  test("uses an effective global workspace during shared initialization", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    await mkdir(join(root, ".git"));
    await mkdir(join(home, ".config", "asana-cli"), { recursive: true });
    await writeJson(join(home, ".config", "asana-cli", "config.json"), {
      workspace: { gid: "100" },
    });
    await writeJson(join(root, ".asana-cli.local.json"), {
      workspace: { gid: "999" },
    });

    const result = await initializeSharedConfig(context(root, home));

    expect(result.ok).toBe(true);
    expect(
      JSON.parse(await readFile(join(root, ".asana-cli.json"), "utf8")),
    ).toEqual({ workspace: { gid: "100" } });
  });

  test("writes shared by default, global explicitly, and myTasks locally", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    await mkdir(join(root, ".git"));
    await writeFile(
      join(root, ".gitignore"),
      "dist/\n/.asana-cli.local.json\n",
    );

    expect(
      (await setConfigValue(context(root, home), "workspace.gid", "100")).ok,
    ).toBe(true);
    expect(
      (await setConfigValue(context(root, home), "team.gid", "200", "global"))
        .ok,
    ).toBe(true);
    expect(
      (
        await setConfigValue(
          context(root, home),
          "myTasks.sections.review",
          "300",
        )
      ).ok,
    ).toBe(true);

    expect(
      JSON.parse(await readFile(join(root, ".asana-cli.json"), "utf8")),
    ).toEqual({ workspace: { gid: "100" } });
    expect(
      JSON.parse(
        await readFile(
          join(home, ".config", "asana-cli", "config.json"),
          "utf8",
        ),
      ),
    ).toEqual({ team: { gid: "200" } });
    expect(
      JSON.parse(await readFile(join(root, ".asana-cli.local.json"), "utf8")),
    ).toEqual({ myTasks: { sections: { review: "300" } } });
  });

  test("rejects unsafe local writes and invalid target values", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    const unsafe = await setConfigValue(
      context(root, join(root, "home")),
      "myTasks.sections.review",
      "300",
    );
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) expect(unsafe.error.message).toContain("not ignored");

    const invalid = await setConfigValue(
      context(root, join(root, "home")),
      "workspace.gid",
      "not-a-gid",
    );
    expect(invalid.ok).toBe(false);
    expect(await Bun.file(join(root, ".asana-cli.json")).exists()).toBe(false);
  });

  test("parses values according to the target schema", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));

    const numeric = await setConfigValue(
      context(root, join(root, "home")),
      "network.concurrency",
      "8",
    );
    expect(numeric.ok).toBe(true);
    expect(
      JSON.parse(await readFile(join(root, ".asana-cli.json"), "utf8")),
    ).toEqual({ network: { concurrency: 8 } });

    for (const invalid of ["1.5", "0", "-1", "NaN", "Infinity", "1e999"]) {
      const result = await setConfigValue(
        context(root, join(root, "home")),
        "network.concurrency",
        invalid,
      );
      expect(result.ok).toBe(false);
    }
    expect(
      JSON.parse(await readFile(join(root, ".asana-cli.json"), "utf8")),
    ).toEqual({ network: { concurrency: 8 } });
  });

  test("accepts matching ignore globs and honors later negation", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    const configContext = context(root, join(root, "home"));
    await writeFile(join(root, ".gitignore"), "**/*.local.json\n");

    const ignored = await setConfigValue(
      configContext,
      "myTasks.sections.review",
      "300",
    );
    expect(ignored.ok).toBe(true);

    await writeFile(
      join(root, ".gitignore"),
      "**/*.local.json\n!/.asana-cli.local.json\n",
    );
    const unignored = await setConfigValue(
      configContext,
      "myTasks.sections.done",
      "301",
    );
    expect(unignored.ok).toBe(false);
    if (!unignored.ok) expect(unignored.error.message).toContain("not ignored");
  });

  test("does not corrupt an existing target when atomic rename fails", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    const target = join(root, ".asana-cli.json");
    await mkdir(target);
    await writeFile(join(target, "sentinel"), "preserved");

    const result = await setConfigValue(
      context(root, join(root, "home")),
      "workspace.gid",
      "100",
    );

    expect(result.ok).toBe(false);
    expect(await readFile(join(target, "sentinel"), "utf8")).toBe("preserved");
    expect(await Bun.file(join(root, ".gitignore")).exists()).toBe(false);
  });
});

describe("getConfigValue", () => {
  test("returns values and their winning source", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "100" },
    });
    const resolved = await resolveConfig(context(root, join(root, "home")));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    expect(getConfigValue(resolved.value, "workspace.gid")).toEqual({
      ok: true,
      value: {
        value: "100",
        source: {
          layer: "shared",
          path: join(root, ".asana-cli.json"),
        },
        sources: {
          "workspace.gid": {
            layer: "shared",
            path: join(root, ".asana-cli.json"),
          },
        },
      },
    });
    expect(getConfigValue(resolved.value, "workspace")).toEqual({
      ok: true,
      value: {
        value: { gid: "100" },
        sources: {
          "workspace.gid": {
            layer: "shared",
            path: join(root, ".asana-cli.json"),
          },
        },
      },
    });
    expect(getConfigValue(resolved.value, "workspace.missing").ok).toBe(false);
    expect(getConfigValue(resolved.value, "workspace..gid").ok).toBe(false);
  });
});

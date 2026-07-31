import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { err, ok, type Result } from "../shared/result.ts";
import {
  getConfigValue,
  initializeSharedConfig,
  resolveConfig,
  setConfigValue,
  initializeLocalConfig,
  type ConfigContext,
  type MyTasksDiscoveryGateway,
  type DiscoveredMyTasks,
  type DiscoveryError,
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
    await mkdir(join(outer, ".git", "worktrees", "test"), { recursive: true });
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

  test("skips a malformed git file and finds the nearest repository", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const nested = join(repository, "nested");
    await mkdir(join(repository, ".git"), { recursive: true });
    await mkdir(nested);
    await writeFile(join(nested, ".git"), "not a gitdir\n");

    const result = await resolveConfig(context(nested, join(root, "home")));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.paths.gitRoot).toBe(repository);
    }
  });

  test("treats a stale git file outside a repository as outside git", async () => {
    const root = await temporaryDirectory();
    const nested = join(root, "plain", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "plain", ".git"), "gitdir: ../missing\n");

    const result = await resolveConfig(context(nested, join(root, "home")));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.paths.gitRoot).toBeUndefined();
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

  test("rejects a local write for an ignore rule with leading whitespace", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".gitignore"), " .asana-cli.local.json\n");

    const result = await setConfigValue(
      context(root, join(root, "home")),
      "myTasks.sections.review",
      "300",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("not ignored");
    expect(await Bun.file(join(root, ".asana-cli.local.json")).exists()).toBe(
      false,
    );
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

  test("initializeSharedConfig fails outside a git repository", async () => {
    const root = await temporaryDirectory();
    const result = await initializeSharedConfig(
      context(root, join(root, "home")),
      "100",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("configuration");
      expect(result.error.message).toContain(
        "shared configuration requires a git repository",
      );
    }
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

describe("initializeLocalConfig", () => {
  const mockDiscovery = (data: DiscoveredMyTasks): MyTasksDiscoveryGateway => ({
    discoverMyTasks: async () => ({ ok: true, value: data }),
  });

  class TrackingDiscovery implements MyTasksDiscoveryGateway {
    public callsCount = 0;
    constructor(
      private readonly response: Result<DiscoveredMyTasks, DiscoveryError>,
    ) {}

    async discoverMyTasks(): Promise<
      Result<DiscoveredMyTasks, DiscoveryError>
    > {
      this.callsCount += 1;
      return this.response;
    }
  }

  test("initializes local config, updates gitignore, and preserves unrelated keys", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });
    // Write an existing local config with an unrelated key
    const localPath = join(root, ".asana-cli.local.json");
    await writeJson(localPath, {
      project: { gid: "999" },
      myTasks: { sections: { stale: "111" } },
    });

    const discoveryData: DiscoveredMyTasks = {
      userTaskListGid: "1213894072990299",
      sections: [
        { gid: "1213894072991394", name: "In Progress" },
        { gid: "1213894072991395", name: "Done" },
      ],
      customFields: [
        {
          gid: "1213894072991499",
          name: "Hours Estimate",
          resourceSubtype: "number",
          isReadOnly: false,
        },
        // Should be ignored (isReadOnly is true)
        {
          gid: "1213894072991500",
          name: "Read Only Field",
          resourceSubtype: "number",
          isReadOnly: true,
        },
        // Should be ignored (resourceSubtype is not number)
        {
          gid: "1213894072991501",
          name: "Text Field",
          resourceSubtype: "text",
          isReadOnly: false,
        },
      ],
    };

    const result = await initializeLocalConfig(
      context(root, join(root, "home")),
      "secret-token",
      mockDiscovery(discoveryData),
      { writeGitignore: true },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.layer).toBe("local");
      expect(result.value.path).toBe(localPath);
    }

    // Verify .gitignore was updated exactly
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore).toBe("/.asana-cli.local.json\n");

    // Verify local config has sorted aliases, is updated, and preserves project.gid
    const localContent = JSON.parse(await readFile(localPath, "utf8"));
    expect(localContent).toEqual({
      project: { gid: "999" },
      myTasks: {
        userTaskListGid: "1213894072990299",
        sections: {
          done: "1213894072991395",
          in_progress: "1213894072991394",
        },
        customFields: {
          hours_estimate: "1213894072991499",
        },
      },
    });
  });

  test("fails without gitignore write if local file is not ignored", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });

    const result = await initializeLocalConfig(
      context(root, join(root, "home")),
      "token",
      mockDiscovery({ userTaskListGid: "1", sections: [], customFields: [] }),
      { writeGitignore: false },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("configuration");
      expect(result.error.message).toContain("not ignored");
    }
  });

  test("succeeds if already ignored without modifying gitignore", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });
    await writeFile(
      join(root, ".gitignore"),
      "/.asana-cli.local.json\nsentinel\n",
    );

    const result = await initializeLocalConfig(
      context(root, join(root, "home")),
      "token",
      mockDiscovery({ userTaskListGid: "1", sections: [], customFields: [] }),
      { writeGitignore: false },
    );

    expect(result.ok).toBe(true);
    // .gitignore remains unchanged
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore).toBe("/.asana-cli.local.json\nsentinel\n");
  });

  test("rejects colliding section aliases", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });
    await writeFile(join(root, ".gitignore"), "/.asana-cli.local.json\n");

    const result = await initializeLocalConfig(
      context(root, join(root, "home")),
      "token",
      mockDiscovery({
        userTaskListGid: "1",
        sections: [
          { gid: "10", name: "In Progress!" },
          { gid: "20", name: "In Progress?" },
        ],
        customFields: [],
      }),
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("configuration");
      expect(result.error.message).toContain("Colliding alias");
    }
  });

  test("rejects empty aliases", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });
    await writeFile(join(root, ".gitignore"), "/.asana-cli.local.json\n");

    const result = await initializeLocalConfig(
      context(root, join(root, "home")),
      "token",
      mockDiscovery({
        userTaskListGid: "1",
        sections: [{ gid: "10", name: "!!!" }],
        customFields: [],
      }),
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("configuration");
      expect(result.error.message).toContain("Generated alias is empty");
    }
  });

  test("fails if workspace.gid is missing", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));

    const tracking = new TrackingDiscovery(
      ok({ userTaskListGid: "1", sections: [], customFields: [] }),
    );
    const result = await initializeLocalConfig(
      context(root, join(root, "home")),
      "token",
      tracking,
      { writeGitignore: true },
    );

    expect(result.ok).toBe(false);
    expect(tracking.callsCount).toBe(0);
    const exists = await stat(join(root, ".asana-cli.local.json"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  test("fails and has no side effects on unsafe ignore", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });

    const tracking = new TrackingDiscovery(
      ok({ userTaskListGid: "1", sections: [], customFields: [] }),
    );
    const result = await initializeLocalConfig(
      context(root, join(root, "home")),
      "token",
      tracking,
      { writeGitignore: false },
    );

    expect(result.ok).toBe(false);
    expect(tracking.callsCount).toBe(0);
    const configExists = await stat(join(root, ".asana-cli.local.json"))
      .then(() => true)
      .catch(() => false);
    const gitignoreExists = await stat(join(root, ".gitignore"))
      .then(() => true)
      .catch(() => false);
    expect(configExists).toBe(false);
    expect(gitignoreExists).toBe(false);
  });

  test("fails and has no side effects on invalid config file", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".asana-cli.json"), "invalid-json\n");

    const tracking = new TrackingDiscovery(
      ok({ userTaskListGid: "1", sections: [], customFields: [] }),
    );
    const result = await initializeLocalConfig(
      context(root, join(root, "home")),
      "token",
      tracking,
      { writeGitignore: true },
    );

    expect(result.ok).toBe(false);
    expect(tracking.callsCount).toBe(0);
    const configExists = await stat(join(root, ".asana-cli.local.json"))
      .then(() => true)
      .catch(() => false);
    const gitignoreExists = await stat(join(root, ".gitignore"))
      .then(() => true)
      .catch(() => false);
    expect(configExists).toBe(false);
    expect(gitignoreExists).toBe(false);
  });

  test("fails and has no side effects on discovery API errors", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });

    const tracking = new TrackingDiscovery(
      err({ kind: "api", message: "Asana API request failed" }),
    );
    const result = await initializeLocalConfig(
      context(root, join(root, "home")),
      "token",
      tracking,
      { writeGitignore: true },
    );

    expect(result.ok).toBe(false);
    expect(tracking.callsCount).toBe(1);
    const configExists = await stat(join(root, ".asana-cli.local.json"))
      .then(() => true)
      .catch(() => false);
    const gitignoreExists = await stat(join(root, ".gitignore"))
      .then(() => true)
      .catch(() => false);
    expect(configExists).toBe(false);
    expect(gitignoreExists).toBe(false);
  });

  test("fails and has no side effects on section alias collisions", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });

    const tracking = new TrackingDiscovery(
      ok({
        userTaskListGid: "1213894072990299",
        sections: [
          { gid: "1", name: "In Progress" },
          { gid: "2", name: "In Progress" },
        ],
        customFields: [],
      }),
    );
    const result = await initializeLocalConfig(
      context(root, join(root, "home")),
      "token",
      tracking,
      { writeGitignore: true },
    );

    expect(result.ok).toBe(false);
    expect(tracking.callsCount).toBe(1);
    const configExists = await stat(join(root, ".asana-cli.local.json"))
      .then(() => true)
      .catch(() => false);
    const gitignoreExists = await stat(join(root, ".gitignore"))
      .then(() => true)
      .catch(() => false);
    expect(configExists).toBe(false);
    expect(gitignoreExists).toBe(false);
  });

  test("fails if gitRoot is missing", async () => {
    const root = await temporaryDirectory();
    const result = await initializeLocalConfig(
      context(root, join(root, "home")),
      "token",
      mockDiscovery({ userTaskListGid: "1", sections: [], customFields: [] }),
      { writeGitignore: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("configuration");
      expect(result.error.message).toContain(
        "local configuration requires a git repository",
      );
    }
  });

  test("rejects empty custom field aliases", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });
    await writeFile(join(root, ".gitignore"), "/.asana-cli.local.json\n");

    const result = await initializeLocalConfig(
      context(root, join(root, "home")),
      "token",
      mockDiscovery({
        userTaskListGid: "1",
        sections: [],
        customFields: [
          {
            gid: "10",
            name: "!!!",
            resourceSubtype: "number",
            isReadOnly: false,
          },
        ],
      }),
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("configuration");
      expect(result.error.message).toContain(
        "Generated alias is empty for custom field",
      );
    }
  });

  test("rejects colliding custom field aliases", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });
    await writeFile(join(root, ".gitignore"), "/.asana-cli.local.json\n");

    const result = await initializeLocalConfig(
      context(root, join(root, "home")),
      "token",
      mockDiscovery({
        userTaskListGid: "1",
        sections: [],
        customFields: [
          {
            gid: "10",
            name: "Estimate",
            resourceSubtype: "number",
            isReadOnly: false,
          },
          {
            gid: "11",
            name: "Estimate!!!",
            resourceSubtype: "number",
            isReadOnly: false,
          },
        ],
      }),
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("configuration");
      expect(result.error.message).toContain("Colliding alias");
    }
  });

  test("removes leading/trailing underscores from generated alias", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });
    await writeFile(join(root, ".gitignore"), "/.asana-cli.local.json\n");

    const result = await initializeLocalConfig(
      context(root, join(root, "home")),
      "token",
      mockDiscovery({
        userTaskListGid: "1",
        sections: [{ gid: "10", name: "__Section Name__" }],
        customFields: [],
      }),
      {},
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.myTasks.sections).toEqual({
        section_name: "10",
      });
    }
  });

  test("handles gitignore with escapes and wildcards (? and **)", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });

    await writeFile(
      join(root, ".gitignore"),
      "\\!escaped\n" +
        "/.asana-cli.local.j?on\n" +
        "**/asana-cli.local.json\n" +
        "**asana-cli.local.json\n",
    );

    const result = await initializeLocalConfig(
      context(root, join(root, "home")),
      "token",
      mockDiscovery({ userTaskListGid: "1", sections: [], customFields: [] }),
      {},
    );
    expect(result.ok).toBe(true);
  });

  test("handles gitignore read error other than ENOENT", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });

    const gitignorePath = join(root, ".gitignore");
    await writeFile(gitignorePath, "some-content\n");
    const { chmod } = await import("node:fs/promises");
    await chmod(gitignorePath, 0o000);

    try {
      const result = await initializeLocalConfig(
        context(root, join(root, "home")),
        "token",
        mockDiscovery({ userTaskListGid: "1", sections: [], customFields: [] }),
        { writeGitignore: true },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("configuration");
        expect(result.error.message).toContain("could not be read");
      }
    } finally {
      await chmod(gitignorePath, 0o600);
    }
  });

  test("handles gitignore write error", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });

    const { chmod } = await import("node:fs/promises");
    await chmod(root, 0o500);

    try {
      const result = await initializeLocalConfig(
        context(root, join(root, "home")),
        "token",
        mockDiscovery({ userTaskListGid: "1", sections: [], customFields: [] }),
        { writeGitignore: true },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("configuration");
        expect(result.error.message).toContain("could not be written");
      }
    } finally {
      await chmod(root, 0o700);
    }
  });

  test("handles local config write error", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });
    await writeFile(join(root, ".gitignore"), "/.asana-cli.local.json\n");

    const { chmod } = await import("node:fs/promises");
    await chmod(root, 0o500);

    try {
      const result = await initializeLocalConfig(
        context(root, join(root, "home")),
        "token",
        mockDiscovery({ userTaskListGid: "1", sections: [], customFields: [] }),
        {},
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("configuration");
        expect(result.error.message).toContain("could not be written");
      }
    } finally {
      await chmod(root, 0o700);
    }
  });

  test("handles gitignore rename error", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });
    const gitignorePath = join(root, ".gitignore");
    await writeFile(gitignorePath, "some-content\n");

    const ctx: ConfigContext = {
      cwd: root,
      home: join(root, "home"),
      environment: {},
      fileOperations: {
        rename: async () => {
          throw new Error("mock rename failure");
        },
      },
    };

    const result = await initializeLocalConfig(
      ctx,
      "token",
      mockDiscovery({ userTaskListGid: "1", sections: [], customFields: [] }),
      { writeGitignore: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("configuration");
      expect(result.error.message).toContain("could not be renamed");
    }
  });

  test("handles local config rename error", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeJson(join(root, ".asana-cli.json"), {
      workspace: { gid: "1201947864389005" },
    });
    await writeFile(join(root, ".gitignore"), "/.asana-cli.local.json\n");

    const ctx: ConfigContext = {
      cwd: root,
      home: join(root, "home"),
      environment: {},
      fileOperations: {
        rename: async () => {
          throw new Error("mock rename failure");
        },
      },
    };

    const result = await initializeLocalConfig(
      ctx,
      "token",
      mockDiscovery({ userTaskListGid: "1", sections: [], customFields: [] }),
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("configuration");
      expect(result.error.message).toContain("could not be renamed");
    }
  });
});

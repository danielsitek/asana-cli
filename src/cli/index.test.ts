import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type MyTasksDiscoveryGateway,
  type DiscoveredMyTasks,
  type DiscoveryError,
} from "../config/index.ts";
import type {
  Identity,
  IdentityError,
  IdentityGateway,
} from "../identity/index.ts";
import {
  type Task,
  type TaskGateway,
  type TaskReadError,
} from "../tasks/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import { execute } from "./index.ts";

class InMemoryIdentity implements IdentityGateway {
  constructor(private readonly response: Result<Identity, IdentityError>) {}

  async getAuthenticatedUser(): Promise<Result<Identity, IdentityError>> {
    return this.response;
  }
}

class InMemoryDiscovery implements MyTasksDiscoveryGateway {
  constructor(
    private readonly response: Result<DiscoveredMyTasks, DiscoveryError>,
  ) {}

  async discoverMyTasks(): Promise<Result<DiscoveredMyTasks, DiscoveryError>> {
    return this.response;
  }
}

class InMemoryTaskReader implements TaskGateway {
  public lastToken?: string;
  public lastTaskId?: string;
  public lastFields?: readonly string[];

  constructor(private readonly response: Result<Task, TaskReadError>) {}

  async getTask(
    token: string,
    taskId: string,
    fields: readonly string[],
  ): Promise<Result<Task, TaskReadError>> {
    this.lastToken = token;
    this.lastTaskId = taskId;
    this.lastFields = fields;
    return this.response;
  }
}

class ThrowingIdentity implements IdentityGateway {
  async getAuthenticatedUser(): Promise<Result<Identity, IdentityError>> {
    const error = new Error("token=secret-value");
    Object.assign(error, { code: "ECONNRESET" });
    throw error;
  }
}

describe("execute", () => {
  const identity = new InMemoryIdentity(
    ok({ gid: "123", name: "Ada Lovelace" }),
  );

  test("renders identity for humans", async () => {
    expect(
      await execute(["whoami"], {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity,
      }),
    ).toEqual({
      stdout: "gid: 123\nname: Ada Lovelace\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("renders stable JSON to stdout", async () => {
    const result = await execute(["whoami", "--json"], {
      environment: { ASANA_CLI_TOKEN: "secret" },
      identity,
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      '{\n  "data": {\n    "gid": "123",\n    "name": "Ada Lovelace"\n  },\n  "meta": {}\n}\n',
    );
  });

  test("rejects a missing token without leaking values", async () => {
    const result = await execute(["whoami"], { environment: {}, identity });
    expect(result).toEqual({
      stdout: "",
      stderr:
        '{\n  "error": {\n    "code": "authentication",\n    "message": "ASANA_CLI_TOKEN is required"\n  }\n}\n',
      exitCode: 3,
    });
  });

  test("maps adapter failures to documented errors without token leakage", async () => {
    const failing = new InMemoryIdentity(
      err({ kind: "authentication", message: "Denied Bearer secret" }),
    );
    const result = await execute(["whoami"], {
      environment: { ASANA_CLI_TOKEN: "secret" },
      identity: failing,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("secret");
  });

  test("maps API and retry exhaustion failures to their exit codes", async () => {
    const api = await execute(["whoami", "--json"], {
      environment: { ASANA_CLI_TOKEN: "secret" },
      identity: new InMemoryIdentity(
        err({ kind: "api", message: "body with secret", status: 500 }),
      ),
    });
    expect(api).toEqual({
      stdout: "",
      stderr:
        '{\n  "error": {\n    "code": "api",\n    "message": "Asana API request failed"\n  }\n}\n',
      exitCode: 4,
    });

    const exhausted = await execute(["whoami"], {
      environment: { ASANA_CLI_TOKEN: "secret" },
      identity: new InMemoryIdentity(
        err({ kind: "rate_limit", message: "secret", status: 429 }),
      ),
    });
    expect(exhausted.exitCode).toBe(5);
    expect(exhausted.stderr).not.toContain("secret");
  });

  test("renders version and help without authenticating", async () => {
    for (const argv of [
      ["-v"],
      ["--version"],
      ["whoami", "-v"],
      ["whoami", "--version"],
    ]) {
      expect(await execute(argv, { environment: {}, identity })).toEqual({
        stdout: "0.1.0\n",
        stderr: "",
        exitCode: 0,
      });
    }

    const helpBefore = await execute(["--help", "whoami"], {
      environment: {},
      identity,
    });
    const helpAfter = await execute(["whoami", "--help"], {
      environment: {},
      identity,
    });
    expect(helpBefore.exitCode).toBe(0);
    expect(helpBefore.stderr).toBe("");
    expect(helpBefore.stdout).toContain("Commands:");
    expect(helpBefore.stdout).toContain("show the authenticated Asana user");
    expect(helpAfter.exitCode).toBe(0);
    expect(helpAfter.stderr).toBe("");
    expect(helpAfter.stdout).toContain("show the authenticated Asana user");
  });

  test("normalizes unknown commands as JSON usage errors", async () => {
    expect(await execute(["unknown"], { environment: {}, identity })).toEqual({
      stdout: "",
      stderr:
        '{\n  "error": {\n    "code": "invalid_usage",\n    "message": "Invalid command usage"\n  }\n}\n',
      exitCode: 2,
    });
  });

  test("hides unexpected dependency errors", async () => {
    const result = await execute(["whoami"], {
      environment: { ASANA_CLI_TOKEN: "secret-value" },
      identity: new ThrowingIdentity(),
    });
    expect(result).toEqual({
      stdout: "",
      stderr:
        '{\n  "error": {\n    "code": "internal_error",\n    "message": "An unexpected internal error occurred"\n  }\n}\n',
      exitCode: 6,
    });
    expect(result.stderr).not.toContain("secret-value");
  });
});

describe("config commands", () => {
  const identity = new InMemoryIdentity(
    ok({ gid: "123", name: "Ada Lovelace" }),
  );
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), "asana-cli-execute-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    await mkdir(join(root, ".git"));
    return {
      root,
      home,
      dependencies: {
        environment: {},
        identity,
        discovery: new InMemoryDiscovery(
          ok({ userTaskListGid: "1", sections: [], customFields: [] }),
        ),
        configuration: { cwd: root, home, environment: {} },
      },
    };
  };

  test("initializes and reads shared configuration", async () => {
    const { root, dependencies } = await setup();

    const initialized = await execute(
      ["config", "init", "--shared", "--workspace=100"],
      dependencies,
    );
    expect(initialized).toEqual({
      stdout: `initialized ${join(root, ".asana-cli.json")}\n`,
      stderr: "",
      exitCode: 0,
    });
    expect(
      JSON.parse(await readFile(join(root, ".asana-cli.json"), "utf8")),
    ).toEqual({ workspace: { gid: "100" } });

    expect(
      await execute(
        ["config", "get", "workspace.gid", "--source"],
        dependencies,
      ),
    ).toEqual({
      stdout:
        `100\nsource layer: shared\n` +
        `source path: ${join(root, ".asana-cli.json")}\n`,
      stderr: "",
      exitCode: 0,
    });
  });

  test("shows deterministic human and JSON configuration with sources", async () => {
    const { root, dependencies } = await setup();
    await writeFile(
      join(root, ".asana-cli.json"),
      '{"workspace":{"gid":"100"},"team":{"gid":"200"}}\n',
    );

    const human = await execute(["config", "show", "--sources"], dependencies);
    expect(human).toEqual({
      stdout:
        "network.concurrency: 4 [built-in]\n" +
        "network.maxRetries: 3 [built-in]\n" +
        "network.requestTimeoutMs: 30000 [built-in]\n" +
        `team.gid: 200 [shared (${join(root, ".asana-cli.json")})]\n` +
        `workspace.gid: 100 [shared (${join(root, ".asana-cli.json")})]\n`,
      stderr: "",
      exitCode: 0,
    });

    const jsonAfter = await execute(
      ["config", "show", "--sources", "--json"],
      dependencies,
    );
    const jsonBefore = await execute(
      ["--json", "config", "show", "--sources"],
      dependencies,
    );
    expect(jsonAfter).toEqual(jsonBefore);
    expect(jsonAfter.exitCode).toBe(0);
    expect(JSON.parse(jsonAfter.stdout)).toEqual({
      data: {
        network: {
          concurrency: 4,
          maxRetries: 3,
          requestTimeoutMs: 30000,
        },
        workspace: { gid: "100" },
        team: { gid: "200" },
      },
      meta: {
        sources: {
          "network.concurrency": { layer: "built-in" },
          "network.maxRetries": { layer: "built-in" },
          "network.requestTimeoutMs": { layer: "built-in" },
          "workspace.gid": {
            layer: "shared",
            path: join(root, ".asana-cli.json"),
          },
          "team.gid": {
            layer: "shared",
            path: join(root, ".asana-cli.json"),
          },
        },
      },
    });
  });

  test("sets selected layers and enforces local ignore safety", async () => {
    const { root, home, dependencies } = await setup();

    const shared = await execute(
      ["config", "set", "workspace.gid", "100"],
      dependencies,
    );
    const global = await execute(
      ["config", "set", "team.gid", "200", "--global", "--json"],
      dependencies,
    );
    const unsafeLocal = await execute(
      ["config", "set", "myTasks.sections.review", "300"],
      dependencies,
    );

    expect(shared.exitCode).toBe(0);
    expect(global.exitCode).toBe(0);
    expect(JSON.parse(global.stdout).data.layer).toBe("global");
    expect(
      JSON.parse(
        await readFile(
          join(home, ".config", "asana-cli", "config.json"),
          "utf8",
        ),
      ),
    ).toEqual({ team: { gid: "200" } });
    expect(unsafeLocal.exitCode).toBe(2);
    expect(unsafeLocal.stderr).toContain("not ignored");

    await writeFile(join(root, ".gitignore"), "/.asana-cli.local.json\n");
    const safeLocal = await execute(
      ["config", "set", "myTasks.sections.review", "300"],
      dependencies,
    );
    expect(safeLocal.exitCode).toBe(0);
  });

  test("sets schema-typed network values and rejects malformed values", async () => {
    const { root, dependencies } = await setup();

    const valid = await execute(
      ["config", "set", "network.concurrency", "8"],
      dependencies,
    );
    expect(valid.exitCode).toBe(0);
    expect(
      JSON.parse(await readFile(join(root, ".asana-cli.json"), "utf8")),
    ).toEqual({ network: { concurrency: 8 } });

    const invalid = await execute(
      ["config", "set", "network.maxRetries", "NaN"],
      dependencies,
    );
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("network.maxRetries");
  });

  test("returns configuration and usage errors with exit code two", async () => {
    const { root, dependencies } = await setup();
    await writeFile(join(root, ".asana-cli.json"), '{"unknown":true}\n');

    const invalidConfig = await execute(["config", "show"], dependencies);
    expect(invalidConfig.exitCode).toBe(2);
    expect(invalidConfig.stdout).toBe("");
    expect(invalidConfig.stderr).toContain(".asana-cli.json");
    expect(invalidConfig.stderr).toContain("unknown");

    const conflicting = await execute(
      ["config", "set", "workspace.gid", "100", "--shared", "--global"],
      dependencies,
    );
    expect(conflicting.exitCode).toBe(2);
    expect(conflicting.stderr).toContain("mutually exclusive");
  });

  test("init --local works with write-gitignore and token", async () => {
    const { root, home } = await setup();
    await writeFile(
      join(root, ".asana-cli.json"),
      '{"workspace":{"gid":"1201947864389005"}}\n',
    );

    const discoveryResponse: DiscoveredMyTasks = {
      userTaskListGid: "1213894072990299",
      sections: [{ gid: "1213894072991394", name: "In Progress" }],
      customFields: [],
    };

    const result = await execute(
      ["config", "init", "--local", "--write-gitignore"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(
          ok({ gid: "123", name: "Ada Lovelace" }),
        ),
        discovery: new InMemoryDiscovery(ok(discoveryResponse)),
        configuration: { cwd: root, home, environment: {} },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `initialized ${join(root, ".asana-cli.local.json")}\n`,
    );

    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore).toBe("/.asana-cli.local.json\n");

    const localConfig = JSON.parse(
      await readFile(join(root, ".asana-cli.local.json"), "utf8"),
    );
    expect(localConfig.myTasks.userTaskListGid).toBe("1213894072990299");
  });

  test("init --local handles partial write where gitignore rename succeeds and local-config rename fails (human mode)", async () => {
    const { root, home } = await setup();
    await writeFile(
      join(root, ".asana-cli.json"),
      '{"workspace":{"gid":"1201947864389005"}}\n',
    );

    const discoveryResponse: DiscoveredMyTasks = {
      userTaskListGid: "1213894072990299",
      sections: [{ gid: "1213894072991394", name: "In Progress" }],
      customFields: [],
    };

    const result = await execute(
      ["config", "init", "--local", "--write-gitignore"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(
          ok({ gid: "123", name: "Ada Lovelace" }),
        ),
        discovery: new InMemoryDiscovery(ok(discoveryResponse)),
        configuration: {
          cwd: root,
          home,
          environment: {},
          fileOperations: {
            rename: async (oldPath: string, newPath: string) => {
              if (newPath.endsWith(".asana-cli.local.json")) {
                throw new Error("mock rename failure for local config");
              }
              const { rename } = await import("node:fs/promises");
              return rename(oldPath, newPath);
            },
          },
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Stage failure");
    expect(result.stdout).toContain("Completed: gitignore");
    expect(result.stdout).toContain("Failed: local_config");

    const gitignoreContent = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignoreContent).toBe("/.asana-cli.local.json\n");

    const localConfigFileExists = await Bun.file(
      join(root, ".asana-cli.local.json"),
    ).exists();
    expect(localConfigFileExists).toBe(false);
  });

  test("init --local handles partial write where gitignore rename succeeds and local-config rename fails (json mode)", async () => {
    const { root, home } = await setup();
    await writeFile(
      join(root, ".asana-cli.json"),
      '{"workspace":{"gid":"1201947864389005"}}\n',
    );

    const discoveryResponse: DiscoveredMyTasks = {
      userTaskListGid: "1213894072990299",
      sections: [{ gid: "1213894072991394", name: "In Progress" }],
      customFields: [],
    };

    const result = await execute(
      ["config", "init", "--local", "--write-gitignore", "--json"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(
          ok({ gid: "123", name: "Ada Lovelace" }),
        ),
        discovery: new InMemoryDiscovery(ok(discoveryResponse)),
        configuration: {
          cwd: root,
          home,
          environment: {},
          fileOperations: {
            rename: async (oldPath: string, newPath: string) => {
              if (newPath.endsWith(".asana-cli.local.json")) {
                throw new Error("mock rename failure for local config");
              }
              const { rename } = await import("node:fs/promises");
              return rename(oldPath, newPath);
            },
          },
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");

    const parsedOutput = JSON.parse(result.stdout);
    expect(parsedOutput.data.completed).toEqual(["gitignore"]);
    expect(parsedOutput.data.failed).toEqual(["local_config"]);
    expect(parsedOutput.data.message).toContain(
      "could not be renamed after writing",
    );
    expect(parsedOutput.meta).toEqual({});

    const gitignoreContent = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignoreContent).toBe("/.asana-cli.local.json\n");

    const localConfigFileExists = await Bun.file(
      join(root, ".asana-cli.local.json"),
    ).exists();
    expect(localConfigFileExists).toBe(false);
  });

  test("init --local fails if missing workspace GID", async () => {
    const { root, home } = await setup();

    const result = await execute(
      ["config", "init", "--local", "--write-gitignore"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(
          ok({ gid: "123", name: "Ada Lovelace" }),
        ),
        discovery: new InMemoryDiscovery(
          ok({ userTaskListGid: "1", sections: [], customFields: [] }),
        ),
        configuration: { cwd: root, home, environment: {} },
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("workspace.gid is required");
  });

  test("resolve my-tasks fails if not ignored", async () => {
    const { root, home } = await setup();
    await writeFile(
      join(root, ".asana-cli.json"),
      '{"workspace":{"gid":"1201947864389005"}}\n',
    );

    const result = await execute(["config", "resolve", "my-tasks"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada Lovelace" })),
      discovery: new InMemoryDiscovery(
        ok({ userTaskListGid: "1", sections: [], customFields: [] }),
      ),
      configuration: { cwd: root, home, environment: {} },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not ignored by the repository .gitignore");
  });

  test("resolve my-tasks succeeds if already ignored", async () => {
    const { root, home } = await setup();
    await writeFile(
      join(root, ".asana-cli.json"),
      '{"workspace":{"gid":"1201947864389005"}}\n',
    );
    await writeFile(join(root, ".gitignore"), "/.asana-cli.local.json\n");

    const discoveryResponse: DiscoveredMyTasks = {
      userTaskListGid: "1213894072990299",
      sections: [{ gid: "1213894072991394", name: "In Progress" }],
      customFields: [],
    };

    const result = await execute(["config", "resolve", "my-tasks"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada Lovelace" })),
      discovery: new InMemoryDiscovery(ok(discoveryResponse)),
      configuration: { cwd: root, home, environment: {} },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "userTaskListGid: 1213894072990299\n" +
        "sections:\n" +
        "  in_progress: 1213894072991394\n" +
        "customFields:\n",
    );
  });

  test("config init rejects invalid flag combinations", async () => {
    const { dependencies } = await setup();

    const noFlags = await execute(["config", "init"], dependencies);
    expect(noFlags.exitCode).toBe(2);
    expect(noFlags.stderr).toContain("requires either --shared or --local");

    const writeGitignoreWithoutLocal = await execute(
      ["config", "init", "--shared", "--write-gitignore"],
      dependencies,
    );
    expect(writeGitignoreWithoutLocal.exitCode).toBe(2);
    expect(writeGitignoreWithoutLocal.stderr).toContain(
      "--write-gitignore requires --local",
    );

    const localWithWorkspace = await execute(
      ["config", "init", "--local", "--workspace=100"],
      dependencies,
    );
    expect(localWithWorkspace.exitCode).toBe(2);
    expect(localWithWorkspace.stderr).toContain(
      "--workspace is not supported with --local",
    );
  });

  test("config commands fail if discovery dependency is missing", async () => {
    const { root, home } = await setup();
    await writeFile(
      join(root, ".asana-cli.json"),
      '{"workspace":{"gid":"1201947864389005"}}\n',
    );
    await writeFile(join(root, ".gitignore"), "/.asana-cli.local.json\n");

    const initResult = await execute(
      ["config", "init", "--local", "--write-gitignore"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
        configuration: { cwd: root, home, environment: {} },
      },
    );
    expect(initResult.exitCode).toBe(6);
    expect(initResult.stderr).toContain("Discovery gateway is required");

    const resolveResult = await execute(["config", "resolve", "my-tasks"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
      configuration: { cwd: root, home, environment: {} },
    });
    expect(resolveResult.exitCode).toBe(6);
    expect(resolveResult.stderr).toContain("Discovery gateway is required");
  });

  test("resolve my-tasks outputs stable JSON", async () => {
    const { root, home } = await setup();
    await writeFile(
      join(root, ".asana-cli.json"),
      '{"workspace":{"gid":"1201947864389005"}}\n',
    );
    await writeFile(join(root, ".gitignore"), "/.asana-cli.local.json\n");

    const discoveryResponse: DiscoveredMyTasks = {
      userTaskListGid: "1213894072990299",
      sections: [{ gid: "1213894072991394", name: "In Progress" }],
      customFields: [],
    };

    const result = await execute(["config", "resolve", "my-tasks", "--json"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada Lovelace" })),
      discovery: new InMemoryDiscovery(ok(discoveryResponse)),
      configuration: { cwd: root, home, environment: {} },
    });

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.data).toEqual({
      userTaskListGid: "1213894072990299",
      sections: {
        in_progress: "1213894072991394",
      },
      customFields: {},
    });
  });

  test("init --local maps identity errors on failure", async () => {
    const { root, home } = await setup();
    await writeFile(
      join(root, ".asana-cli.json"),
      '{"workspace":{"gid":"1201947864389005"}}\n',
    );

    const result = await execute(
      ["config", "init", "--local", "--write-gitignore"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(
          ok({ gid: "123", name: "Ada Lovelace" }),
        ),
        discovery: new InMemoryDiscovery(
          err({ kind: "rate_limit", message: "retries exhausted" }),
        ),
        configuration: { cwd: root, home, environment: {} },
      },
    );

    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("rate_limit");
  });

  test("config init rejects mutually exclusive flags --shared and --local", async () => {
    const { dependencies } = await setup();
    const result = await execute(
      ["config", "init", "--shared", "--local"],
      dependencies,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "--shared and --local are mutually exclusive",
    );
  });

  test("config init --shared fails when workspace GID is missing", async () => {
    const { dependencies } = await setup();
    const result = await execute(["config", "init", "--shared"], dependencies);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("requires --workspace or a workspace.gid");
  });

  test("config init --local fails if token is missing", async () => {
    const { dependencies } = await setup();
    dependencies.environment = {};
    const result = await execute(["config", "init", "--local"], dependencies);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("ASANA_CLI_TOKEN is required");
  });

  test("config resolve my-tasks fails if token is missing", async () => {
    const { dependencies } = await setup();
    dependencies.environment = {};
    const result = await execute(
      ["config", "resolve", "my-tasks"],
      dependencies,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("ASANA_CLI_TOKEN is required");
  });

  test("config resolve my-tasks maps identity errors on failure", async () => {
    const { root, home } = await setup();
    await writeFile(
      join(root, ".asana-cli.json"),
      '{"workspace":{"gid":"1201947864389005"}}\n',
    );
    await writeFile(join(root, ".gitignore"), "/.asana-cli.local.json\n");

    const result = await execute(["config", "resolve", "my-tasks"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada Lovelace" })),
      discovery: new InMemoryDiscovery(
        err({ kind: "rate_limit", message: "retries exhausted" }),
      ),
      configuration: { cwd: root, home, environment: {} },
    });

    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("rate_limit");
  });

  test("config get fails when configuration is invalid", async () => {
    const { root, dependencies } = await setup();
    await writeFile(join(root, ".asana-cli.json"), "malformed-json");
    const result = await execute(
      ["config", "get", "workspace.gid"],
      dependencies,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid JSON");
  });

  test("config get fails for non-existent key", async () => {
    const { root, dependencies } = await setup();
    await writeFile(
      join(root, ".asana-cli.json"),
      '{"workspace":{"gid":"100"}}\n',
    );
    const result = await execute(
      ["config", "get", "non.existent.key"],
      dependencies,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("non.existent.key");
  });
});

describe("tasks get command", () => {
  const dummyTask: Task = {
    gid: "1215978111726134",
    name: "Implement task reading",
    notes: "This is a notes section\nwith multiple lines",
    completed: false,
    due_on: "2026-12-31",
    assignee: {
      gid: "9876",
      name: "Ada Lovelace",
    },
  };

  test("reads task and outputs human-readable deterministic details", async () => {
    const result = await execute(["tasks", "get", "1215978111726134"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
      taskReader: new InMemoryTaskReader(ok(dummyTask)),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        "gid: 1215978111726134",
        "name: Implement task reading",
        "notes:",
        "  This is a notes section",
        "  with multiple lines",
        "completed: false",
        "due_on: 2026-12-31",
        "assignee.gid: 9876",
        "assignee.name: Ada Lovelace",
      ].join("\n") + "\n",
    );
    expect(result.stderr).toBe("");
  });

  test("reads task and outputs JSON", async () => {
    const result = await execute(
      ["tasks", "get", "1215978111726134", "--json"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
        taskReader: new InMemoryTaskReader(ok(dummyTask)),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      JSON.stringify({ data: dummyTask, meta: {} }, null, 2) + "\n",
    );
    expect(result.stderr).toBe("");
  });

  test("fails fast on invalid ID before checking authentication or making calls", async () => {
    const result = await execute(["tasks", "get", "invalid-id"], {
      environment: {},
      identity: new InMemoryIdentity(
        err({ kind: "authentication", message: "fail" }),
      ),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid task identifier");
    expect(result.stdout).toBe("");
  });

  test("rejects fields option on non-supporting commands", async () => {
    const result = await execute(["whoami", "--fields", "notes"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Option --fields is not supported");
    expect(result.stdout).toBe("");
  });

  test("maps task reader errors correctly to stderr and exit codes without token leak", async () => {
    const failingReader = new InMemoryTaskReader(
      err({ kind: "not_found", message: "Task not found", status: 404 }),
    );

    const result = await execute(["tasks", "get", "1215978111726134"], {
      environment: { ASANA_CLI_TOKEN: "top-secret-token" },
      identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
      taskReader: failingReader,
    });

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain('"code": "not_found"');
    expect(result.stderr).toContain("Task not found");
    expect(result.stderr).not.toContain("top-secret-token");
  });

  test("records and asserts token, parsed task GID, and exact fields (URL extraction, defaults)", async () => {
    const reader = new InMemoryTaskReader(ok(dummyTask));
    const result = await execute(
      [
        "tasks",
        "get",
        "https://app.asana.com/0/1201947864389005/1215978111726134",
      ],
      {
        environment: { ASANA_CLI_TOKEN: "custom-token-123" },
        identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
        taskReader: reader,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(reader.lastToken).toBe("custom-token-123");
    expect(reader.lastTaskId).toBe("1215978111726134");
    expect(reader.lastFields).toEqual([
      "gid",
      "name",
      "notes",
      "completed",
      "due_on",
      "assignee.gid",
      "assignee.name",
    ]);
  });

  test("allows fields flag before subcommand", async () => {
    const reader = new InMemoryTaskReader(ok(dummyTask));
    const result = await execute(
      ["--fields", "name,notes", "tasks", "get", "1215978111726134"],
      {
        environment: { ASANA_CLI_TOKEN: "token-abc" },
        identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
        taskReader: reader,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(reader.lastFields).toEqual(["name", "notes"]);
  });

  test("allows fields flag after subcommand", async () => {
    const reader = new InMemoryTaskReader(ok(dummyTask));
    const result = await execute(
      ["tasks", "get", "1215978111726134", "--fields", "name,notes"],
      {
        environment: { ASANA_CLI_TOKEN: "token-abc" },
        identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
        taskReader: reader,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(reader.lastFields).toEqual(["name", "notes"]);
  });

  test("invalid fields list fails before reader or auth calls", async () => {
    const reader = new InMemoryTaskReader(ok(dummyTask));
    // Pass empty SEGMENT inside --fields:
    const result = await execute(
      ["tasks", "get", "1215978111726134", "--fields", "name,,notes"],
      {
        environment: {}, // No token provided, but it shouldn't even check token or reader!
        identity: new InMemoryIdentity(
          err({ kind: "authentication", message: "fail" }),
        ),
        taskReader: reader,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "Fields list cannot contain empty segments",
    );
    expect(reader.lastTaskId).toBeUndefined(); // Reader was NOT called!
  });

  test("maps task reader errors correctly for other kinds", async () => {
    const errors: Record<TaskReadError["kind"], number> = {
      authentication: 3,
      api: 4,
      not_found: 4,
      rate_limit: 5,
      network: 4,
      invalid_response: 4,
    };

    for (const [kind, exitCode] of Object.entries(errors)) {
      const failingReader = new InMemoryTaskReader(
        err({
          kind: kind as TaskReadError["kind"],
          message: `error for ${kind}`,
        }),
      );
      const result = await execute(["tasks", "get", "1215978111726134"], {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
        taskReader: failingReader,
      });
      expect(result.exitCode).toBe(exitCode);
      expect(result.stderr).toContain(kind);
    }
  });

  test("handles thrown internal dependency error in task reader cleanly", async () => {
    const throwingReader = {
      getTask: async () => {
        throw new Error("unexpected db/connection crash!");
      },
    };

    const result = await execute(["tasks", "get", "1215978111726134"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
      taskReader: throwingReader,
    });

    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("unexpected internal error");
    expect(result.stderr).not.toContain("unexpected db/connection crash!"); // Ensure actual error details are not leaked!
  });
});

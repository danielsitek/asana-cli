import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type MyTaskSectionsDiscoveryGateway,
  type MyTasksDiscoveryGateway,
  type DiscoveredMyTasks,
  type DiscoveryError,
} from "../config/index.ts";
import type {
  Identity,
  IdentityError,
  IdentityGateway,
} from "../identity/index.ts";
import type { TaskStoryGateway } from "../comments/index.ts";
import type {
  Workspace,
  WorkspaceGateway,
  WorkspaceListError,
} from "../workspaces/index.ts";
import {
  type Task,
  type TaskCreationGateway,
  type TaskCreationTarget,
  type TaskGateway,
  type TaskListGateway,
  type TaskListPage,
  type TaskMutation,
  type TaskMutationGateway,
  type TaskParentMutationGateway,
  type TaskReadError,
} from "../tasks/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import { execute, type ExecuteDependencies } from "./index.ts";

const taskReadErrorCases = <
  const Cases extends readonly (readonly [TaskReadError["kind"], number])[],
>(
  cases: Exclude<TaskReadError["kind"], Cases[number][0]> extends never
    ? Cases
    : never,
): Cases => cases;

class InMemoryIdentity implements IdentityGateway {
  constructor(private readonly response: Result<Identity, IdentityError>) {}

  async getAuthenticatedUser(): Promise<Result<Identity, IdentityError>> {
    return this.response;
  }
}

class InMemoryDiscovery
  implements MyTasksDiscoveryGateway, MyTaskSectionsDiscoveryGateway
{
  constructor(
    private readonly response: Result<DiscoveredMyTasks, DiscoveryError>,
  ) {}

  async discoverMyTasks(): Promise<Result<DiscoveredMyTasks, DiscoveryError>> {
    return this.response;
  }

  async discoverMyTaskSections() {
    if (!this.response.ok) return this.response;
    const { userTaskListGid, sections } = this.response.value;
    return ok({ userTaskListGid, sections });
  }
}

class InMemoryTaskReader implements TaskGateway {
  public lastToken?: string;
  public lastTaskId?: string;
  public lastFields?: readonly string[];
  public callCount = 0;

  constructor(private readonly response: Result<Task, TaskReadError>) {}

  async getTask(
    token: string,
    taskId: string,
    fields: readonly string[],
  ): Promise<Result<Task, TaskReadError>> {
    this.callCount += 1;
    this.lastToken = token;
    this.lastTaskId = taskId;
    this.lastFields = fields;
    return this.response;
  }
}

class InMemoryTaskWriter implements TaskMutationGateway {
  public calls: Array<
    Readonly<{
      token: string;
      taskId: string;
      mutation: TaskMutation;
      fields?: readonly string[];
    }>
  > = [];

  constructor(private readonly response: Result<Task, TaskReadError>) {}

  async updateTask(
    token: string,
    taskId: string,
    mutation: TaskMutation,
    fields?: readonly string[],
  ): Promise<Result<Task, TaskReadError>> {
    this.calls.push({
      token,
      taskId,
      mutation,
      ...(fields === undefined ? {} : { fields }),
    });
    return this.response;
  }
}

class InMemoryTaskParentWriter implements TaskParentMutationGateway {
  public calls: Array<
    Readonly<{
      token: string;
      taskId: string;
      parentId: string | null;
      fields?: readonly string[];
    }>
  > = [];

  constructor(private readonly response: Result<Task, TaskReadError>) {}

  async setTaskParent(
    token: string,
    taskId: string,
    parentId: string | null,
    fields?: readonly string[],
  ): Promise<Result<Task, TaskReadError>> {
    this.calls.push({
      token,
      taskId,
      parentId,
      ...(fields === undefined ? {} : { fields }),
    });
    return this.response;
  }
}

class InMemoryTaskCreator implements TaskCreationGateway {
  public calls: Array<
    Readonly<{
      token: string;
      target: TaskCreationTarget;
      mutation: TaskMutation;
      fields?: readonly string[];
    }>
  > = [];

  constructor(
    private readonly response: Result<
      Task & Readonly<{ gid: string }>,
      TaskReadError
    >,
  ) {}

  async createTask(
    token: string,
    target: TaskCreationTarget,
    mutation: TaskMutation,
    fields?: readonly string[],
  ): Promise<Result<Task & Readonly<{ gid: string }>, TaskReadError>> {
    this.calls.push({
      token,
      target,
      mutation,
      ...(fields === undefined ? {} : { fields }),
    });
    return this.response;
  }
}

class StagedTaskWriter implements TaskMutationGateway {
  public calls: Array<
    Readonly<{
      token: string;
      taskId: string;
      mutation: TaskMutation;
      fields?: readonly string[];
    }>
  > = [];

  constructor(
    private readonly responses: readonly Result<Task, TaskReadError>[],
  ) {}

  async updateTask(
    token: string,
    taskId: string,
    mutation: TaskMutation,
    fields?: readonly string[],
  ): Promise<Result<Task, TaskReadError>> {
    this.calls.push({
      token,
      taskId,
      mutation,
      ...(fields === undefined ? {} : { fields }),
    });
    return (
      this.responses[this.calls.length - 1] ??
      err({ kind: "invalid_response", message: "Missing fake response" })
    );
  }
}

class InMemoryWorkspaceReader implements WorkspaceGateway {
  public calls: Array<Readonly<{ limit: number; offset?: string }>> = [];

  constructor(
    private readonly pages: readonly Result<
      Readonly<{ workspaces: readonly Workspace[]; nextOffset?: string }>,
      WorkspaceListError
    >[],
  ) {}

  async listWorkspaces(
    _token: string,
    options: Readonly<{ limit: number; offset?: string }>,
  ) {
    this.calls.push(options);
    const page = this.pages[this.calls.length - 1];
    if (!page) throw new Error("no more pages queued");
    return page;
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
      '{"data":{"gid":"123","name":"Ada Lovelace"},"meta":{}}\n',
    );
  });

  test("rejects a missing token without leaking values", async () => {
    const result = await execute(["whoami"], { environment: {}, identity });
    expect(result).toEqual({
      stdout: "",
      stderr:
        '{"error":{"code":"authentication","message":"ASANA_CLI_TOKEN is required"}}\n',
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
      stderr: '{"error":{"code":"api","message":"Asana API request failed"}}\n',
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
    expect(helpBefore.stdout).toContain("select explicit Asana fields");
    expect(helpBefore.stdout).toContain("show the authenticated Asana user");
    expect(helpBefore.stdout).toContain("generate shell completion script");
    expect(helpAfter.exitCode).toBe(0);
    expect(helpAfter.stderr).toBe("");
    expect(helpAfter.stdout).toContain("show the authenticated Asana user");
  });

  test("empty invocation returns top-level help without dependencies", async () => {
    const environment = new Proxy<Record<string, string | undefined>>(
      {},
      {
        get: () => {
          throw new Error("environment accessed");
        },
      },
    );
    const dependencies: ExecuteDependencies = {
      environment,
      identity: {
        getAuthenticatedUser: async () => {
          throw new Error("identity called");
        },
      },
      discovery: {
        discoverMyTasks: async () => {
          throw new Error("discovery called");
        },
      },
      taskReader: {
        getTask: async () => {
          throw new Error("task reader called");
        },
      },
      get configuration(): never {
        throw new Error("configuration accessed");
      },
    };

    const explicitHelp = await execute(["--help"], dependencies);
    const emptyInvocation = await execute([], dependencies);

    expect(emptyInvocation).toEqual(explicitHelp);
    expect(emptyInvocation.exitCode).toBe(0);
    expect(emptyInvocation.stderr).toBe("");
    expect(emptyInvocation.stdout).toContain("Usage: asana-cli");
  });

  test("generates completion scripts without authentication or configuration", async () => {
    const dependencies: ExecuteDependencies = {
      environment: new Proxy(
        {},
        {
          get: () => {
            throw new Error("environment accessed");
          },
        },
      ),
      identity: {
        getAuthenticatedUser: async () => {
          throw new Error("identity called");
        },
      },
      get configuration(): never {
        throw new Error("configuration accessed");
      },
    };

    const bash = await execute(["completion", "bash"], dependencies);
    const zsh = await execute(["completion", "zsh"], dependencies);
    const fish = await execute(["completion", "fish"], dependencies);

    expect(bash).toMatchObject({ exitCode: 0, stderr: "" });
    expect(bash.stdout).toContain(
      "'tasks') candidates='get update create comments comment list",
    );
    expect(bash.stdout).toContain(
      "'tasks/get') candidates='-v --version --json --fields",
    );
    expect(bash.stdout).toContain(
      "'whoami') candidates='-v --version --json -h --help'",
    );
    expect(zsh).toMatchObject({ exitCode: 0, stderr: "" });
    expect(zsh.stdout).toContain("#compdef asana-cli");
    expect(fish).toMatchObject({ exitCode: 0, stderr: "" });
    expect(fish.stdout).toContain("function __asana_cli_context_is");
  });

  test("rejects an unsupported completion shell", async () => {
    expect(
      await execute(["completion", "powershell"], {
        environment: {},
        identity,
      }),
    ).toEqual({
      stdout: "",
      stderr:
        '{"error":{"code":"invalid_usage","message":"Unsupported shell: powershell; expected bash, zsh, fish"}}\n',
      exitCode: 2,
    });
  });

  test("normalizes unknown commands as JSON usage errors", async () => {
    expect(await execute(["unknown"], { environment: {}, identity })).toEqual({
      stdout: "",
      stderr:
        '{"error":{"code":"invalid_usage","message":"Invalid command usage"}}\n',
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
        '{"error":{"code":"internal_error","message":"An unexpected internal error occurred"}}\n',
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

  test("routes an unflagged defaultAssignee to local and rejects it for shared/global", async () => {
    const { root, home, dependencies } = await setup();
    await writeFile(join(root, ".gitignore"), "/.asana-cli.local.json\n");

    const unflagged = await execute(
      ["--json", "config", "set", "defaultAssignee", "me"],
      dependencies,
    );
    expect(unflagged.exitCode).toBe(0);
    expect(JSON.parse(unflagged.stdout).data.layer).toBe("local");
    expect(
      JSON.parse(await readFile(join(root, ".asana-cli.local.json"), "utf8")),
    ).toEqual({ defaultAssignee: "me" });

    const shared = await execute(
      ["config", "set", "defaultAssignee", "me", "--shared"],
      dependencies,
    );
    expect(shared.exitCode).toBe(2);
    expect(await Bun.file(join(root, ".asana-cli.json")).exists()).toBe(false);

    const global = await execute(
      ["config", "set", "defaultAssignee", "me", "--global"],
      dependencies,
    );
    expect(global.exitCode).toBe(2);
    expect(
      await Bun.file(
        join(home, ".config", "asana-cli", "config.json"),
      ).exists(),
    ).toBe(false);
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
    expect(result.stdout).toBe(JSON.stringify(parsedOutput) + "\n");
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
      JSON.stringify({ data: dummyTask, meta: {} }) + "\n",
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
    expect(result.stderr).toContain('"code":"not_found"');
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
    const result = await execute(
      ["tasks", "get", "1215978111726134", "--fields", "name,,notes"],
      {
        environment: {},
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
    expect(reader.callCount).toBe(0);
  });

  test("maps task reader errors correctly for other kinds", async () => {
    const errors = taskReadErrorCases([
      ["authentication", 3],
      ["api", 4],
      ["not_found", 4],
      ["rate_limit", 5],
      ["network", 4],
      ["invalid_response", 4],
    ]);

    for (const [kind, exitCode] of errors) {
      const failingReader = new InMemoryTaskReader(
        err({
          kind,
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
    expect(result.stderr).not.toContain("unexpected db/connection crash!");
  });
});

describe("tasks update --parent", () => {
  const identity = new InMemoryIdentity(ok({ gid: "9001", name: "Ada" }));
  const movedTask: Task = { gid: "222", name: "Moved" };

  const isolatedDependencies = (): ExecuteDependencies => ({
    environment: new Proxy<Record<string, string | undefined>>(
      {},
      {
        get: () => {
          throw new Error("environment accessed");
        },
      },
    ),
    identity,
    get taskParentWriter(): never {
      throw new Error("task parent writer accessed");
    },
    get taskWriter(): never {
      throw new Error("task writer accessed");
    },
    get taskReader(): never {
      throw new Error("task reader accessed");
    },
    get discovery(): never {
      throw new Error("discovery accessed");
    },
    get configuration(): never {
      throw new Error("configuration accessed");
    },
    get readFile(): never {
      throw new Error("file reader accessed");
    },
    get readStdin(): never {
      throw new Error("stdin reader accessed");
    },
  });

  test.each([
    ["invalid task id", ["tasks", "update", "invalid", "--parent", "456"]],
    ["malformed parent", ["tasks", "update", "222", "--parent", "not-a-gid"]],
    ["self parent by GID", ["tasks", "update", "222", "--parent", "222"]],
    [
      "self parent by URL",
      ["tasks", "update", "222", "--parent", "https://app.asana.com/0/111/222"],
    ],
    [
      "combined name",
      ["tasks", "update", "222", "--parent", "456", "--name", "Updated"],
    ],
    [
      "combined notes",
      ["tasks", "update", "222", "--parent", "456", "--notes", "text"],
    ],
    [
      "combined notes file",
      ["tasks", "update", "222", "--parent", "456", "--notes-file", "n.md"],
    ],
    [
      "combined assignee",
      ["tasks", "update", "222", "--parent", "456", "--assignee", "me"],
    ],
    [
      "combined due date",
      ["tasks", "update", "222", "--parent", "456", "--due-on", "2028-02-29"],
    ],
    [
      "combined completed",
      ["tasks", "update", "222", "--parent", "456", "--completed", "true"],
    ],
    [
      "combined My Tasks section",
      ["tasks", "update", "222", "--parent", "456", "--my-section", "300"],
    ],
    [
      "combined custom field",
      ["tasks", "update", "222", "--parent", "456", "--custom-field", "400:1"],
    ],
  ])("rejects %s before any dependency access", async (_, argv) => {
    const result = await execute(argv, isolatedDependencies());

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
  });

  test("reports a missing token before accessing the parent writer", async () => {
    const result = await execute(
      ["tasks", "update", "222", "--parent", "456"],
      {
        environment: {},
        identity,
        get taskParentWriter(): never {
          throw new Error("task parent writer accessed");
        },
      },
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("ASANA_CLI_TOKEN is required");
  });

  test("requires an injected parent writer", async () => {
    const result = await execute(
      ["tasks", "update", "222", "--parent", "456"],
      {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity,
      },
    );

    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("Task parent writer is required");
  });

  test.each([
    ["a GID", "456", "456"],
    ["a task URL", "https://app.asana.com/0/111/456", "456"],
  ])(
    "reparents through %s with exactly one write",
    async (_, parent, expected) => {
      const writer = new InMemoryTaskParentWriter(ok(movedTask));
      const result = await execute(
        ["tasks", "update", "222", "--parent", parent],
        {
          environment: { ASANA_CLI_TOKEN: "secret" },
          identity,
          taskParentWriter: writer,
          get taskWriter(): never {
            throw new Error("task writer accessed");
          },
          get taskReader(): never {
            throw new Error("task reader accessed");
          },
          get configuration(): never {
            throw new Error("configuration accessed");
          },
        },
      );

      expect(result).toEqual({
        stdout: "gid: 222\nname: Moved\napplied:\n  parent: 456\n",
        stderr: "",
        exitCode: 0,
      });
      expect(writer.calls).toEqual([
        { token: "secret", taskId: "222", parentId: expected },
      ]);
    },
  );

  test("promotes a subtask with --parent=null", async () => {
    const writer = new InMemoryTaskParentWriter(ok(movedTask));
    const result = await execute(
      ["tasks", "update", "222", "--parent", "null"],
      {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity,
        taskParentWriter: writer,
      },
    );

    expect(result).toEqual({
      stdout: "gid: 222\nname: Moved\napplied:\n  parent: —\n",
      stderr: "",
      exitCode: 0,
    });
    expect(writer.calls).toEqual([
      { token: "secret", taskId: "222", parentId: null },
    ]);
  });

  test("renders the reparented task as JSON", async () => {
    const writer = new InMemoryTaskParentWriter(ok(movedTask));
    const result = await execute(
      ["--json", "tasks", "update", "222", "--parent", "456"],
      {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity,
        taskParentWriter: writer,
      },
    );

    expect(JSON.parse(result.stdout)).toEqual({
      data: movedTask,
      meta: { applied: { parent: "456" } },
    });
    expect(result.exitCode).toBe(0);
  });

  test.each(
    taskReadErrorCases([
      ["authentication", 3],
      ["api", 4],
      ["not_found", 4],
      ["rate_limit", 5],
      ["network", 4],
      ["invalid_response", 4],
    ]),
  )("maps %s parent failures to exit code %i", async (kind, exitCode) => {
    const writer = new InMemoryTaskParentWriter(
      err({ kind, message: "unsafe secret response" }),
    );
    const result = await execute(
      ["tasks", "update", "222", "--parent", "456"],
      {
        environment: { ASANA_CLI_TOKEN: "top-secret" },
        identity,
        taskParentWriter: writer,
      },
    );

    expect(result.exitCode).toBe(exitCode);
    expect(result.stderr).not.toContain("unsafe secret response");
    expect(result.stderr).not.toContain("top-secret");
    expect(writer.calls).toHaveLength(1);
  });
});

describe("tasks update command", () => {
  const identity = new InMemoryIdentity(ok({ gid: "9001", name: "Ada" }));
  const updatedTask: Task = { gid: "123", name: "Updated" };

  test("validates invalid updates before accessing any dependency", async () => {
    const environment = new Proxy<Record<string, string | undefined>>(
      {},
      {
        get: () => {
          throw new Error("environment accessed");
        },
      },
    );
    const dependencies: ExecuteDependencies = {
      environment,
      identity,
      get taskWriter(): never {
        throw new Error("task writer accessed");
      },
      get taskReader(): never {
        throw new Error("task reader accessed");
      },
      get discovery(): never {
        throw new Error("discovery accessed");
      },
      get configuration(): never {
        throw new Error("configuration accessed");
      },
      get readFile(): never {
        throw new Error("file reader accessed");
      },
      get readStdin(): never {
        throw new Error("stdin reader accessed");
      },
    };

    for (const argv of [
      ["tasks", "update", "invalid", "--name", "x"],
      ["tasks", "update", "123"],
      ["tasks", "update", "123", "--notes", "x", "--notes-file", "notes.md"],
      ["tasks", "update", "123", "--assignee", "email@example.com"],
      ["tasks", "update", "123", "--due-on", "2026-02-29"],
      ["tasks", "update", "123", "--completed", "yes"],
      ["tasks", "update", "123", "--my-section", "section"],
      [
        "tasks",
        "update",
        "123",
        "--custom-field",
        "400:1",
        "--custom-field",
        "400:2",
      ],
    ]) {
      const result = await execute(argv, dependencies);
      expect(result.exitCode).toBe(2);
    }
  });

  test("reports a missing token before accessing the task writer", async () => {
    const dependencies: ExecuteDependencies = {
      environment: {},
      identity,
      get taskWriter(): never {
        throw new Error("task writer accessed");
      },
    };

    const result = await execute(
      ["tasks", "update", "123", "--name", "Updated"],
      dependencies,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("ASANA_CLI_TOKEN is required");
  });

  test("writes all task fields and renders the returned task", async () => {
    const writer = new InMemoryTaskWriter(ok(updatedTask));
    const result = await execute(
      [
        "tasks",
        "update",
        "123",
        "--name",
        "Updated",
        "--notes",
        "Replacement",
        "--assignee",
        "me",
        "--due-on",
        "2028-02-29",
        "--completed",
        "false",
      ],
      {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity,
        taskWriter: writer,
      },
    );

    expect(result).toEqual({
      stdout:
        "gid: 123\n" +
        "name: Updated\n" +
        "applied:\n" +
        "  name: Updated\n" +
        "  notes: Replacement\n" +
        "  assignee: 9001\n" +
        "  due_on: 2028-02-29\n" +
        "  completed: false\n",
      stderr: "",
      exitCode: 0,
    });
    expect(writer.calls).toEqual([
      {
        token: "secret",
        taskId: "123",
        mutation: {
          name: "Updated",
          notes: "Replacement",
          assignee: "9001",
          due_on: "2028-02-29",
          completed: false,
        },
      },
    ]);
  });

  test("reads file and stdin notes unchanged through injected seams", async () => {
    for (const [flagValue, expected] of [
      ["notes.md", "file contents\n\n"],
      ["-", "stdin contents\n"],
    ] as const) {
      const writer = new InMemoryTaskWriter(ok(updatedTask));
      let fileReads = 0;
      let stdinReads = 0;
      const result = await execute(
        ["tasks", "update", "123", "--notes-file", flagValue],
        {
          environment: { ASANA_CLI_TOKEN: "secret" },
          identity,
          taskWriter: writer,
          readFile: async (path) => {
            fileReads += 1;
            expect(path).toBe("notes.md");
            return "file contents\n\n";
          },
          readStdin: async () => {
            stdinReads += 1;
            return "stdin contents\n";
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(writer.calls[0]?.mutation.notes).toBe(expected);
      expect(fileReads).toBe(flagValue === "-" ? 0 : 1);
      expect(stdinReads).toBe(flagValue === "-" ? 1 : 0);
    }
  });

  test("passes assignee and due date nulls to the writer", async () => {
    const writer = new InMemoryTaskWriter(ok(updatedTask));
    const result = await execute(
      ["tasks", "update", "123", "--assignee", "null", "--due-on", "null"],
      {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity,
        taskWriter: writer,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(writer.calls[0]?.mutation).toEqual({
      assignee: null,
      due_on: null,
    });
  });

  test.each([
    ["authentication", 3],
    ["api", 4],
    ["not_found", 4],
    ["rate_limit", 5],
    ["network", 4],
    ["invalid_response", 4],
  ] as const)(
    "maps %s update errors to exit code %i",
    async (kind, exitCode) => {
      const writer = new InMemoryTaskWriter(
        err({ kind, message: "unsafe secret response" }),
      );
      const result = await execute(
        ["tasks", "update", "123", "--name", "Updated"],
        {
          environment: { ASANA_CLI_TOKEN: "top-secret" },
          identity,
          taskWriter: writer,
        },
      );

      expect(result.exitCode).toBe(exitCode);
      expect(result.stderr).not.toContain("unsafe secret response");
      expect(result.stderr).not.toContain("top-secret");
    },
  );

  test("returns JSON output and sends no fields by default", async () => {
    const writer = new InMemoryTaskWriter(ok(updatedTask));
    const json = await execute(
      ["--json", "tasks", "update", "123", "--name", "Updated"],
      {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity,
        taskWriter: writer,
      },
    );
    expect(JSON.parse(json.stdout)).toEqual({
      data: updatedTask,
      meta: { applied: { name: "Updated" } },
    });
    expect(writer.calls[0]?.fields).toBeUndefined();
  });

  test.each([
    [
      [
        "--fields",
        "due_on",
        "tasks",
        "update",
        "123",
        "--due-on",
        "2026-08-15",
      ],
    ],
    [
      [
        "tasks",
        "update",
        "123",
        "--due-on",
        "2026-08-15",
        "--fields",
        "due_on",
      ],
    ],
  ])("passes --fields to the writer for %o", async (argv) => {
    const narrowed = { gid: "123", due_on: "2026-08-15" };
    const writer = new InMemoryTaskWriter(ok(narrowed));
    const result = await execute(["--json", ...argv], {
      environment: { ASANA_CLI_TOKEN: "secret" },
      identity,
      taskWriter: writer,
    });

    expect(result.exitCode).toBe(0);
    expect(writer.calls[0]?.fields).toEqual(["due_on"]);
    expect(JSON.parse(result.stdout)).toEqual({
      data: narrowed,
      meta: { applied: { due_on: "2026-08-15" } },
    });
  });

  test("passes --fields to the parent writer", async () => {
    const narrowed = { gid: "123", name: "Child" };
    const writer = new InMemoryTaskParentWriter(ok(narrowed));
    const result = await execute(
      ["--json", "--fields", "name", "tasks", "update", "123", "--parent", "9"],
      {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity,
        taskParentWriter: writer,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(writer.calls[0]?.fields).toEqual(["name"]);
    expect(JSON.parse(result.stdout)).toEqual({
      data: narrowed,
      meta: { applied: { parent: "9" } },
    });
  });

  test.each([",", " ", "name,,notes"])(
    "rejects malformed --fields %p before any write or token access",
    async (fields) => {
      const writer = new InMemoryTaskWriter(ok(updatedTask));
      const result = await execute(
        ["--fields", fields, "tasks", "update", "123", "--name", "Updated"],
        { environment: {}, identity, taskWriter: writer },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("invalid_usage");
      expect(writer.calls).toHaveLength(0);
    },
  );

  test("renders human output for a narrowed update response", async () => {
    const writer = new InMemoryTaskWriter(
      ok({ gid: "123", due_on: "2026-08-15" }),
    );
    const result = await execute(
      [
        "--fields",
        "due_on",
        "tasks",
        "update",
        "123",
        "--due-on",
        "2026-08-15",
      ],
      {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity,
        taskWriter: writer,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("due_on");
    expect(result.stdout).toContain("applied:");
    expect(result.stdout).not.toContain("undefined");
  });

  test("still rejects --fields on commands that do not support it", async () => {
    const result = await execute(["--fields", "name", "whoami"], {
      environment: { ASANA_CLI_TOKEN: "secret" },
      identity,
    });
    expect(result.exitCode).toBe(2);
  });

  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  const myTasksDependencies = async (
    overrides: Partial<ExecuteDependencies> = {},
    localMyTasks: Record<string, unknown> = {
      userTaskListGid: "200",
      sections: { in_review: "300" },
      customFields: { estimate: "400", priority: "600" },
    },
  ): Promise<ExecuteDependencies> => {
    const root = await mkdtemp(join(tmpdir(), "asana-cli-update-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".git"));
    await writeFile(
      join(root, ".asana-cli.json"),
      JSON.stringify({ workspace: { gid: "100" } }),
    );
    await writeFile(
      join(root, ".asana-cli.local.json"),
      JSON.stringify({ myTasks: localMyTasks }),
    );
    return {
      environment: { ASANA_CLI_TOKEN: "secret" },
      identity,
      taskReader: new InMemoryTaskReader(
        ok({ gid: "123", assignee: { gid: "9001", name: "Ada" } }),
      ),
      taskWriter: new InMemoryTaskWriter(ok(updatedTask)),
      discovery: new InMemoryDiscovery(
        ok({
          userTaskListGid: "200",
          sections: [{ gid: "300", name: "In Review" }],
          customFields: [
            {
              gid: "400",
              name: "Estimate",
              resourceSubtype: "number",
              isReadOnly: false,
            },
            {
              gid: "500",
              name: "Cost",
              resourceSubtype: "number",
              isReadOnly: false,
            },
            {
              gid: "600",
              name: "Priority",
              resourceSubtype: "enum",
              isReadOnly: false,
              enumOptions: [
                { gid: "601", name: "Low", enabled: true },
                { gid: "602", name: "High", enabled: true },
                { gid: "603", name: "Archived", enabled: false },
              ],
            },
          ],
        }),
      ),
      configuration: { cwd: root, home: join(root, "home"), environment: {} },
      ...overrides,
    };
  };

  test("applies aliased and raw My Tasks values with deterministic output", async () => {
    const dependencies = await myTasksDependencies();
    const writer = dependencies.taskWriter as InMemoryTaskWriter;
    const argv = [
      "tasks",
      "update",
      "123",
      "--name",
      "Updated",
      "--assignee",
      "me",
      "--my-section",
      "@in_review",
      "--custom-field",
      "500:2.5",
      "--custom-field",
      "@estimate:null",
    ];

    const human = await execute(argv, dependencies);
    expect(human).toEqual({
      stdout:
        "gid: 123\n" +
        "name: Updated\n" +
        "applied:\n" +
        "  name: Updated\n" +
        "  assignee: 9001\n" +
        "  assignee_section: 300\n" +
        "  custom_fields.400: —\n" +
        "  custom_fields.500: 2.5\n",
      stderr: "",
      exitCode: 0,
    });
    expect(writer.calls).toEqual([
      {
        token: "secret",
        taskId: "123",
        mutation: {
          name: "Updated",
          assignee: "9001",
          assignee_section: "300",
          custom_fields: { "400": null, "500": 2.5 },
        },
      },
    ]);

    const jsonDependencies = await myTasksDependencies();
    const json = await execute(["--json", ...argv], jsonDependencies);
    expect(JSON.parse(json.stdout)).toEqual({
      data: updatedTask,
      meta: {
        applied: {
          name: "Updated",
          assignee: "9001",
          assignee_section: "300",
          custom_fields: { "400": null, "500": 2.5 },
        },
      },
    });
  });

  test("maps a My Tasks configuration failure before writing", async () => {
    const dependencies = await myTasksDependencies();
    const writer = dependencies.taskWriter as InMemoryTaskWriter;
    const result = await execute(
      ["tasks", "update", "123", "--my-section", "@missing"],
      dependencies,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("is not configured");
    expect(writer.calls).toHaveLength(0);
  });

  test("resolves enum custom fields by option GID and by exact name", async () => {
    const dependencies = await myTasksDependencies();
    const writer = dependencies.taskWriter as InMemoryTaskWriter;
    const result = await execute(
      [
        "tasks",
        "update",
        "123",
        "--custom-field",
        "600:601",
        "--custom-field",
        "@estimate:null",
      ],
      dependencies,
    );

    expect(result.exitCode).toBe(0);
    expect(writer.calls).toEqual([
      {
        token: "secret",
        taskId: "123",
        mutation: { custom_fields: { "400": null, "600": "601" } },
      },
    ]);

    const byName = await myTasksDependencies();
    const nameWriter = byName.taskWriter as InMemoryTaskWriter;
    const nameResult = await execute(
      ["tasks", "update", "123", "--custom-field", "@priority:High"],
      byName,
    );

    expect(nameResult.exitCode).toBe(0);
    expect(nameWriter.calls).toEqual([
      {
        token: "secret",
        taskId: "123",
        mutation: { custom_fields: { "600": "602" } },
      },
    ]);
  });

  test("rejects malformed numeric, unknown, ambiguous, and disabled enum values without writing", async () => {
    for (const value of ["1e3", "1,5", "NaN"]) {
      const dependencies = await myTasksDependencies();
      const writer = dependencies.taskWriter as InMemoryTaskWriter;
      const result = await execute(
        ["tasks", "update", "123", "--custom-field", `500:${value}`],
        dependencies,
      );
      expect(result.exitCode).toBe(2);
      expect(writer.calls).toHaveLength(0);
    }

    const unknown = await myTasksDependencies();
    const unknownWriter = unknown.taskWriter as InMemoryTaskWriter;
    const unknownResult = await execute(
      ["tasks", "update", "123", "--custom-field", "600:Medium"],
      unknown,
    );
    expect(unknownResult.exitCode).toBe(2);
    expect(unknownResult.stderr).toContain("is unknown");
    expect(unknownResult.stderr).toContain("High");
    expect(unknownResult.stderr).toContain("Low");
    expect(unknownWriter.calls).toHaveLength(0);

    const disabled = await myTasksDependencies();
    const disabledWriter = disabled.taskWriter as InMemoryTaskWriter;
    const disabledResult = await execute(
      ["tasks", "update", "123", "--custom-field", "600:Archived"],
      disabled,
    );
    expect(disabledResult.exitCode).toBe(2);
    expect(disabledWriter.calls).toHaveLength(0);

    const ambiguous = await myTasksDependencies({
      discovery: new InMemoryDiscovery(
        ok({
          userTaskListGid: "200",
          sections: [{ gid: "300", name: "In Review" }],
          customFields: [
            {
              gid: "600",
              name: "Priority",
              resourceSubtype: "enum",
              isReadOnly: false,
              enumOptions: [
                { gid: "601", name: "Low", enabled: true },
                { gid: "604", name: "Low", enabled: true },
              ],
            },
          ],
        }),
      ),
    });
    const ambiguousWriter = ambiguous.taskWriter as InMemoryTaskWriter;
    const ambiguousResult = await execute(
      ["tasks", "update", "123", "--custom-field", "600:Low"],
      ambiguous,
    );
    expect(ambiguousResult.exitCode).toBe(2);
    expect(ambiguousResult.stderr).toContain("is ambiguous");
    expect(ambiguousWriter.calls).toHaveLength(0);
  });

  test("plain updates do not access My Tasks dependencies", async () => {
    const writer = new InMemoryTaskWriter(ok(updatedTask));
    const dependencies: ExecuteDependencies = {
      environment: { ASANA_CLI_TOKEN: "secret" },
      identity,
      taskWriter: writer,
      get taskReader(): never {
        throw new Error("task reader accessed");
      },
      get discovery(): never {
        throw new Error("discovery accessed");
      },
      get configuration(): never {
        throw new Error("configuration accessed");
      },
    };

    const result = await execute(
      ["tasks", "update", "123", "--name", "Updated"],
      dependencies,
    );
    expect(result.exitCode).toBe(0);
    expect(writer.calls).toHaveLength(1);
  });

  test("never consults defaultAssignee, even with a malformed local config on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "asana-cli-update-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".asana-cli.local.json"), "not valid json");
    const writer = new InMemoryTaskWriter(ok(updatedTask));

    const result = await execute(
      ["tasks", "update", "123", "--name", "Updated"],
      {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity,
        taskWriter: writer,
        configuration: { cwd: root, home: join(root, "home"), environment: {} },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(writer.calls).toEqual([
      { token: "secret", taskId: "123", mutation: { name: "Updated" } },
    ]);
  });
});

describe("tasks create command", () => {
  const temporaryDirectories: string[] = [];
  const identity = new InMemoryIdentity(ok({ gid: "9001", name: "Ada" }));

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  const localMyTasksConfiguration = {
    myTasks: {
      userTaskListGid: "200",
      sections: { in_progress: "300" },
      customFields: { estimate: "400", priority: "600" },
    },
  } as const;

  const dependenciesFor = async (
    writerResponses: readonly Result<Task, TaskReadError>[] = [
      ok({ gid: "456", name: "Child", assignee: { gid: "9001" } }),
      ok({ gid: "456", name: "Child", assignee: { gid: "9001" } }),
      ok({ gid: "456", name: "Child", assignee: { gid: "9001" } }),
    ],
    creatorResponse: Result<
      Task & Readonly<{ gid: string }>,
      TaskReadError
    > = ok({ gid: "456", name: "Child" }),
  ) => {
    const root = await mkdtemp(join(tmpdir(), "asana-cli-create-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".git"));
    await writeFile(
      join(root, ".asana-cli.json"),
      JSON.stringify({ workspace: { gid: "100" } }),
    );
    await writeFile(
      join(root, ".asana-cli.local.json"),
      JSON.stringify(localMyTasksConfiguration),
    );
    const creator = new InMemoryTaskCreator(creatorResponse);
    const writer = new StagedTaskWriter(writerResponses);
    const reader = new InMemoryTaskReader(
      err({ kind: "api", message: "create must not read a child task" }),
    );
    return {
      creator,
      writer,
      reader,
      dependencies: {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity,
        taskCreator: creator,
        taskWriter: writer,
        taskReader: reader,
        discovery: new InMemoryDiscovery(
          ok({
            userTaskListGid: "200",
            sections: [{ gid: "300", name: "In Progress" }],
            customFields: [
              {
                gid: "400",
                name: "Estimate",
                resourceSubtype: "number",
                isReadOnly: false,
              },
              {
                gid: "600",
                name: "Priority",
                resourceSubtype: "enum",
                isReadOnly: false,
                enumOptions: [
                  { gid: "601", name: "Low", enabled: true },
                  { gid: "602", name: "High", enabled: true },
                ],
              },
            ],
          }),
        ),
        configuration: { cwd: root, home: join(root, "home"), environment: {} },
        readFile: async () => "Prepared notes\n",
      } satisfies ExecuteDependencies,
    };
  };

  const writeLocalConfig = async (
    dependencies: ExecuteDependencies,
    value: Readonly<Record<string, unknown>> | string,
  ): Promise<void> => {
    const configuration = dependencies.configuration;
    if (!configuration) throw new Error("configuration is required");
    await writeFile(
      join(configuration.cwd, ".asana-cli.local.json"),
      typeof value === "string"
        ? value
        : JSON.stringify({ ...localMyTasksConfiguration, ...value }),
    );
  };

  test("validates every syntactic input before accessing dependencies", async () => {
    const dependencies: ExecuteDependencies = {
      get environment(): never {
        throw new Error("environment accessed");
      },
      identity,
      get taskCreator(): never {
        throw new Error("creator accessed");
      },
      get taskWriter(): never {
        throw new Error("writer accessed");
      },
      get taskReader(): never {
        throw new Error("reader accessed");
      },
      get discovery(): never {
        throw new Error("discovery accessed");
      },
      get configuration(): never {
        throw new Error("configuration accessed");
      },
      get readFile(): never {
        throw new Error("file reader accessed");
      },
    };

    for (const argv of [
      ["tasks", "create", "--name", "Child"],
      ["tasks", "create", "--parent", "123"],
      ["tasks", "create", "--parent", "invalid", "--name", "Child"],
      [
        "tasks",
        "create",
        "--parent",
        "123",
        "--name",
        "Child",
        "--notes",
        "x",
        "--notes-file",
        "notes.md",
      ],
      [
        "tasks",
        "create",
        "--parent",
        "123",
        "--name",
        "Child",
        "--assignee",
        "ada@example.com",
      ],
      [
        "tasks",
        "create",
        "--parent",
        "123",
        "--name",
        "Child",
        "--due-on",
        "2026-02-29",
      ],
      [
        "tasks",
        "create",
        "--parent",
        "123",
        "--name",
        "Child",
        "--completed",
        "yes",
      ],
      [
        "tasks",
        "create",
        "--parent",
        "123",
        "--name",
        "Child",
        "--my-section",
        "@in_progress",
        "--assignee",
        "ada@example.com",
      ],
    ]) {
      const result = await execute(argv, dependencies);
      expect(result.exitCode).toBe(2);
    }
  });

  test("fails My Tasks values without an assignable user when no configuration context exists", async () => {
    const dependencies: ExecuteDependencies = {
      environment: {},
      identity,
      get taskCreator(): never {
        throw new Error("creator accessed");
      },
    };

    const result = await execute(
      [
        "tasks",
        "create",
        "--parent",
        "123",
        "--name",
        "Child",
        "--my-section",
        "@in_progress",
      ],
      dependencies,
    );
    expect(result.exitCode).toBe(2);
  });

  test("lists every landing alternative for a bare create", async () => {
    const result = await execute(["tasks", "create", "--name", "Task"], {
      environment: {},
      identity,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--parent");
    expect(result.stderr).toContain("--my-section");
    expect(result.stderr).toContain("--project");
  });

  test("creates standalone My Tasks and project tasks", async () => {
    const myTasksSetup = await dependenciesFor();
    const myTasksResult = await execute(
      [
        "tasks",
        "create",
        "--name",
        "My task",
        "--assignee",
        "me",
        "--my-section",
        "@in_progress",
      ],
      myTasksSetup.dependencies,
    );
    expect(myTasksResult.exitCode).toBe(0);
    expect(myTasksSetup.creator.calls[0]?.target).toEqual({
      kind: "workspace",
      workspaceGid: "100",
    });

    const projectSetup = await dependenciesFor();
    const projectResult = await execute(
      ["tasks", "create", "--name", "Project task", "--project", "800"],
      projectSetup.dependencies,
    );
    expect(projectResult.exitCode).toBe(0);
    expect(projectSetup.creator.calls[0]?.target).toEqual({
      kind: "project",
      projectGid: "800",
    });
  });

  test("prevalidates and applies every stage in dependency order", async () => {
    const setup = await dependenciesFor();
    const result = await execute(
      [
        "--json",
        "tasks",
        "create",
        "--parent",
        "123",
        "--name",
        "Child",
        "--notes-file",
        "notes.md",
        "--assignee",
        "me",
        "--due-on",
        "2028-02-29",
        "--completed",
        "false",
        "--my-section",
        "@in_progress",
        "--custom-field",
        "@estimate:4",
      ],
      setup.dependencies,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(setup.reader.callCount).toBe(0);
    expect(setup.creator.calls).toEqual([
      {
        token: "secret",
        target: { kind: "subtask", parentId: "123" },
        mutation: {
          name: "Child",
          notes: "Prepared notes\n",
          due_on: "2028-02-29",
          completed: false,
        },
      },
    ]);
    expect(setup.writer.calls.map((call) => call.mutation)).toEqual([
      { assignee: "9001" },
      { assignee_section: "300" },
      { custom_fields: { "400": 4 } },
    ]);
    expect(JSON.parse(result.stdout)).toEqual({
      data: { gid: "456", name: "Child", assignee: { gid: "9001" } },
      meta: {
        stages: [
          {
            stage: "create",
            status: "completed",
            applied: {
              name: "Child",
              notes: "Prepared notes\n",
              due_on: "2028-02-29",
              completed: false,
            },
          },
          {
            stage: "assignee",
            status: "completed",
            applied: { assignee: "9001" },
          },
          {
            stage: "my_section",
            status: "completed",
            applied: { assignee_section: "300" },
          },
          {
            stage: "custom_fields",
            status: "completed",
            applied: { custom_fields: { "400": 4 } },
          },
        ],
      },
    });
  });

  test("resolves an enum custom field by exact name on creation", async () => {
    const setup = await dependenciesFor();
    const result = await execute(
      [
        "tasks",
        "create",
        "--parent",
        "123",
        "--name",
        "Child",
        "--assignee",
        "me",
        "--custom-field",
        "@priority:High",
      ],
      setup.dependencies,
    );

    expect(result.exitCode).toBe(0);
    expect(setup.writer.calls.map((call) => call.mutation)).toEqual([
      { assignee: "9001" },
      { custom_fields: { "600": "602" } },
    ]);
  });

  test("rejects an unknown enum option on creation without any writes", async () => {
    const setup = await dependenciesFor();
    const result = await execute(
      [
        "tasks",
        "create",
        "--parent",
        "123",
        "--name",
        "Child",
        "--assignee",
        "me",
        "--custom-field",
        "600:Medium",
      ],
      setup.dependencies,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("is unknown");
    expect(setup.creator.calls).toHaveLength(0);
    expect(setup.writer.calls).toHaveLength(0);
  });

  test("renders a useful human result for a basic subtask", async () => {
    const setup = await dependenciesFor([]);
    const dependenciesWithoutWriter: ExecuteDependencies = {
      environment: setup.dependencies.environment,
      identity,
      taskCreator: setup.creator,
    };
    const result = await execute(
      ["tasks", "create", "--parent", "123", "--name", "Child"],
      dependenciesWithoutWriter,
    );

    expect(result).toEqual({
      stdout:
        "gid: 456\n" +
        "name: Child\n" +
        "stages:\n" +
        "  create: completed\n" +
        "  assignee: not_run\n" +
        "    reason: not_requested\n" +
        "  my_section: not_run\n" +
        "    reason: not_requested\n" +
        "  custom_fields: not_run\n" +
        "    reason: not_requested\n",
      stderr: "",
      exitCode: 0,
    });
    expect(setup.writer.calls).toHaveLength(0);
  });

  test("rejects a missing writer for a requested stage before POST", async () => {
    const setup = await dependenciesFor();
    const dependenciesWithoutWriter: ExecuteDependencies = {
      environment: setup.dependencies.environment,
      identity,
      taskCreator: setup.creator,
    };
    const result = await execute(
      [
        "tasks",
        "create",
        "--parent",
        "123",
        "--name",
        "Child",
        "--assignee",
        "me",
      ],
      dependenciesWithoutWriter,
    );
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain(
      "Task writer is required for staged task mutations",
    );
    expect(setup.creator.calls).toHaveLength(0);
  });

  test("renders a representative partial result with exit code one", async () => {
    const setup = await dependenciesFor([
      ok({ gid: "456", name: "Child" }),
      err({ kind: "api", message: "unsafe detail" }),
    ]);
    const result = await execute(
      [
        "--json",
        "tasks",
        "create",
        "--parent",
        "123",
        "--name",
        "Child",
        "--assignee",
        "me",
        "--my-section",
        "300",
        "--custom-field",
        "400:4",
      ],
      setup.dependencies,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(setup.writer.calls).toHaveLength(2);
    const parsedOutput = JSON.parse(result.stdout);
    expect(result.stdout).toBe(JSON.stringify(parsedOutput) + "\n");
    const stages = parsedOutput.meta.stages as Array<{
      status: string;
      error?: { message: string };
    }>;
    expect(stages.map((stage) => stage.status)).toEqual([
      "completed",
      "completed",
      "failed",
      "not_run",
    ]);
    expect(stages[2]?.error?.message).toBe("Asana API request failed");
    expect(result.stdout).not.toContain("unsafe detail");
  });

  test("applies a configured default assignee of me when --assignee is omitted", async () => {
    const setup = await dependenciesFor();
    await writeLocalConfig(setup.dependencies, { defaultAssignee: "me" });

    const result = await execute(
      ["tasks", "create", "--parent", "123", "--name", "Child"],
      setup.dependencies,
    );

    expect(result.exitCode).toBe(0);
    expect(setup.writer.calls.map((call) => call.mutation)).toEqual([
      { assignee: "9001" },
    ]);
  });

  test("applies a configured default GID assignee without an identity lookup", async () => {
    const setup = await dependenciesFor();
    await writeLocalConfig(setup.dependencies, { defaultAssignee: "8002" });
    const identityThatMustNotBeCalled: IdentityGateway = {
      getAuthenticatedUser: async () => {
        throw new Error("identity accessed for a GID default");
      },
    };

    const result = await execute(
      ["tasks", "create", "--parent", "123", "--name", "Child"],
      { ...setup.dependencies, identity: identityThatMustNotBeCalled },
    );

    expect(result.exitCode).toBe(0);
    expect(setup.writer.calls.map((call) => call.mutation)).toEqual([
      { assignee: "8002" },
    ]);
  });

  test("a configured default assignee satisfies the My Tasks precondition", async () => {
    const setup = await dependenciesFor();
    await writeLocalConfig(setup.dependencies, { defaultAssignee: "me" });

    const result = await execute(
      [
        "tasks",
        "create",
        "--parent",
        "123",
        "--name",
        "Child",
        "--my-section",
        "@in_progress",
      ],
      setup.dependencies,
    );

    expect(result.exitCode).toBe(0);
    expect(setup.writer.calls.map((call) => call.mutation)).toEqual([
      { assignee: "9001" },
      { assignee_section: "300" },
    ]);
  });

  test("explicit --assignee overrides a configured default and skips config lookup", async () => {
    const setup = await dependenciesFor();
    await writeLocalConfig(setup.dependencies, "not valid json");

    const result = await execute(
      [
        "tasks",
        "create",
        "--parent",
        "123",
        "--name",
        "Child",
        "--assignee",
        "9001",
      ],
      setup.dependencies,
    );

    expect(result.exitCode).toBe(0);
    expect(setup.writer.calls.map((call) => call.mutation)).toEqual([
      { assignee: "9001" },
    ]);
  });

  test("explicit --assignee=me overrides a configured GID default and skips config lookup", async () => {
    const setup = await dependenciesFor();
    await writeLocalConfig(setup.dependencies, "not valid json");

    const result = await execute(
      [
        "tasks",
        "create",
        "--parent",
        "123",
        "--name",
        "Child",
        "--assignee",
        "me",
      ],
      setup.dependencies,
    );

    expect(result.exitCode).toBe(0);
    expect(setup.writer.calls.map((call) => call.mutation)).toEqual([
      { assignee: "9001" },
    ]);
  });

  test("explicit --assignee=null overrides a configured default", async () => {
    const setup = await dependenciesFor();
    await writeLocalConfig(setup.dependencies, { defaultAssignee: "me" });

    const result = await execute(
      [
        "tasks",
        "create",
        "--parent",
        "123",
        "--name",
        "Child",
        "--assignee",
        "null",
      ],
      setup.dependencies,
    );

    expect(result.exitCode).toBe(0);
    expect(setup.creator.calls).toHaveLength(1);
    expect(setup.writer.calls.map((call) => call.mutation)).toEqual([
      { assignee: null },
    ]);
  });

  test("without a configured default a normal create remains unassigned", async () => {
    const setup = await dependenciesFor();

    const result = await execute(
      ["tasks", "create", "--parent", "123", "--name", "Child"],
      setup.dependencies,
    );

    expect(result.exitCode).toBe(0);
    expect(setup.creator.calls).toHaveLength(1);
    expect(setup.writer.calls).toHaveLength(0);
  });

  test("fails before token, identity, or API access when local config is malformed", async () => {
    const setup = await dependenciesFor();
    await writeLocalConfig(setup.dependencies, "not valid json");
    const dependencies: ExecuteDependencies = {
      ...setup.dependencies,
      get environment(): never {
        throw new Error("environment accessed");
      },
      identity: {
        getAuthenticatedUser: async () => {
          throw new Error("identity accessed");
        },
      },
      get taskCreator(): never {
        throw new Error("creator accessed");
      },
    };

    const result = await execute(
      ["tasks", "create", "--parent", "123", "--name", "Child"],
      dependencies,
    );

    expect(result.exitCode).toBe(2);
  });
});

class InMemoryCommentReader {
  calls = 0;
  async getTaskStories() {
    this.calls += 1;
    return ok({
      stories: [
        {
          gid: "1",
          created_at: "2024-01-01T00:00:00.000Z",
          text: "hi",
          created_by: { gid: "1001", name: "Ada" },
          resource_subtype: "comment_added",
        },
      ],
    });
  }
}

class InMemoryCommentWriter {
  lastText?: string;
  lastFields?: readonly string[];
  async createTaskComment(
    _token: string,
    _taskId: string,
    text: string,
    fields: readonly string[],
  ) {
    this.lastText = text;
    this.lastFields = fields;
    return ok({
      gid: "9",
      created_at: "2024-01-01T00:00:00.000Z",
      text,
      created_by: { gid: "1001", name: "Ada" },
    });
  }
}

describe("tasks comments command", () => {
  test("reads comments and outputs a human-readable table", async () => {
    const result = await execute(["tasks", "comments", "1215978111726134"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
      commentReader: new InMemoryCommentReader(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gid");
    expect(result.stdout).toContain("hi");
    expect(result.stderr).toBe("");
  });

  test("warns in human output when the story scan cap is reached", async () => {
    const reader: TaskStoryGateway = {
      getTaskStories: async () =>
        ok({
          stories: [
            {
              gid: "1",
              resource_subtype: "assigned",
            },
          ],
          nextOffset: "page-2",
        }),
    };
    const result = await execute(
      ["tasks", "comments", "1215978111726134", "--max", "1"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
        commentReader: reader,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Warning:");
    expect(result.stderr).toBe(
      "Warning: story scan cap reached; more comments may exist.\n",
    );
  });

  test("outputs stable JSON data and pagination metadata", async () => {
    const result = await execute(
      ["--json", "tasks", "comments", "1215978111726134"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
        commentReader: new InMemoryCommentReader(),
      },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      data: [
        {
          gid: "1",
          created_at: "2024-01-01T00:00:00.000Z",
          text: "hi",
          created_by: { gid: "1001", name: "Ada" },
        },
      ],
      meta: { scanned: 1, returned: 1, scan_truncated: false },
    });
  });

  test("rejects invalid --max before any reader call", async () => {
    const reader = new InMemoryCommentReader();
    const result = await execute(
      ["tasks", "comments", "1215978111726134", "--max", "0"],
      {
        environment: new Proxy(
          {},
          {
            get: () => {
              throw new Error("authentication must not be read");
            },
          },
        ),
        identity: new InMemoryIdentity(
          err({ kind: "authentication", message: "fail" }),
        ),
        commentReader: reader,
      },
    );
    expect(result.exitCode).toBe(2);
    expect(reader.calls).toBe(0);
  });

  test("maps a not_found comment reader error", async () => {
    const failingReader: TaskStoryGateway = {
      getTaskStories: async () =>
        err<TaskReadError>({
          kind: "not_found",
          status: 404,
          message: "Task not found",
        }),
    };
    const result = await execute(["tasks", "comments", "1215978111726134"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
      commentReader: failingReader,
    });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("not_found");
  });

  test("--latest returns only the newest N comments, newest first, in JSON", async () => {
    const reader: TaskStoryGateway = {
      getTaskStories: async () =>
        ok({
          stories: [
            {
              gid: "1",
              created_at: "2024-01-01T00:00:00.000Z",
              text: "first",
              created_by: { gid: "1001", name: "Ada" },
              resource_subtype: "comment_added",
            },
            {
              gid: "2",
              created_at: "2024-01-02T00:00:00.000Z",
              text: "second",
              created_by: { gid: "1001", name: "Ada" },
              resource_subtype: "comment_added",
            },
          ],
        }),
    };
    const result = await execute(
      [
        "--json",
        "tasks",
        "comments",
        "1215978111726134",
        "--max",
        "10",
        "--latest",
        "1",
      ],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
        commentReader: reader,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      data: [
        {
          gid: "2",
          created_at: "2024-01-02T00:00:00.000Z",
          text: "second",
          created_by: { gid: "1001", name: "Ada" },
        },
      ],
      meta: { scanned: 2, returned: 1, scan_truncated: false },
    });
  });

  test("--latest renders newest-first in the human table", async () => {
    const reader: TaskStoryGateway = {
      getTaskStories: async () =>
        ok({
          stories: [
            {
              gid: "1",
              created_at: "2024-01-01T00:00:00.000Z",
              text: "older",
              created_by: { gid: "1001", name: "Ada" },
              resource_subtype: "comment_added",
            },
            {
              gid: "2",
              created_at: "2024-01-02T00:00:00.000Z",
              text: "newer",
              created_by: { gid: "1001", name: "Ada" },
              resource_subtype: "comment_added",
            },
          ],
        }),
    };
    const result = await execute(
      ["tasks", "comments", "1215978111726134", "--max", "10", "--latest", "2"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
        commentReader: reader,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.indexOf("newer")).toBeLessThan(
      result.stdout.indexOf("older"),
    );
  });

  test("rejects --latest without --max before any reader call", async () => {
    const reader = new InMemoryCommentReader();
    const result = await execute(
      ["tasks", "comments", "1215978111726134", "--latest", "1"],
      {
        environment: new Proxy(
          {},
          {
            get: () => {
              throw new Error("authentication must not be read");
            },
          },
        ),
        identity: new InMemoryIdentity(
          err({ kind: "authentication", message: "fail" }),
        ),
        commentReader: reader,
      },
    );
    expect(result.exitCode).toBe(2);
    expect(reader.calls).toBe(0);
  });

  test("rejects invalid --latest values before any reader call", async () => {
    for (const invalid of ["0", "-1", "1.5", "abc"]) {
      const reader = new InMemoryCommentReader();
      const result = await execute(
        [
          "tasks",
          "comments",
          "1215978111726134",
          "--max",
          "10",
          "--latest",
          invalid,
        ],
        {
          environment: { ASANA_CLI_TOKEN: "valid-token" },
          identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
          commentReader: reader,
        },
      );
      expect(result.exitCode).toBe(2);
      expect(reader.calls).toBe(0);
    }
  });

  test("rejects --latest with --all before any reader call", async () => {
    const reader = new InMemoryCommentReader();
    const result = await execute(
      [
        "tasks",
        "comments",
        "1215978111726134",
        "--max",
        "10",
        "--latest",
        "1",
        "--all",
      ],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
        commentReader: reader,
      },
    );
    expect(result.exitCode).toBe(2);
    expect(reader.calls).toBe(0);
  });

  test("rejects --latest with --offset before any reader call", async () => {
    const reader = new InMemoryCommentReader();
    const result = await execute(
      [
        "tasks",
        "comments",
        "1215978111726134",
        "--max",
        "10",
        "--latest",
        "1",
        "--offset",
        "opaque-token",
      ],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
        commentReader: reader,
      },
    );
    expect(result.exitCode).toBe(2);
    expect(reader.calls).toBe(0);
  });

  test("fails with scan_limit exit 5 and no data when more stories are known at the cap", async () => {
    const reader: TaskStoryGateway = {
      getTaskStories: async () =>
        ok({
          stories: [
            {
              gid: "1",
              created_at: "2024-01-01T00:00:00.000Z",
              text: "hi",
              created_by: { gid: "1001", name: "Ada" },
              resource_subtype: "comment_added",
            },
          ],
          nextOffset: "page-2",
        }),
    };
    const result = await execute(
      ["tasks", "comments", "1215978111726134", "--max", "1", "--latest", "1"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
        commentReader: reader,
      },
    );
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("scan_limit");
  });
});

describe("tasks comment command", () => {
  test("creates a comment from positional text", async () => {
    const writer = new InMemoryCommentWriter();
    const result = await execute(
      ["tasks", "comment", "1215978111726134", "Ready for review"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
        commentWriter: writer,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(writer.lastText).toBe("Ready for review");
    expect(result.stdout).toContain("Ready for review");
  });

  test("creates a comment from stdin via --file=-", async () => {
    const writer = new InMemoryCommentWriter();
    const result = await execute(
      ["tasks", "comment", "1215978111726134", "--file", "-"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity: new InMemoryIdentity(ok({ gid: "123", name: "Ada" })),
        commentWriter: writer,
        readStdin: async () => "from stdin",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(writer.lastText).toBe("from stdin");
  });

  test("rejects empty positional text before any writer call", async () => {
    const writer = new InMemoryCommentWriter();
    const result = await execute(["tasks", "comment", "1215978111726134", ""], {
      environment: new Proxy(
        {},
        {
          get: () => {
            throw new Error("authentication must not be read");
          },
        },
      ),
      identity: new InMemoryIdentity(
        err({ kind: "authentication", message: "fail" }),
      ),
      commentWriter: writer,
    });
    expect(result.exitCode).toBe(2);
    expect(writer.lastText).toBeUndefined();
  });
});

class InMemoryTaskListReader implements TaskListGateway {
  calls: Array<
    Readonly<{
      kind: "section" | "project";
      gid: string;
      options: Readonly<{
        fields: readonly string[];
        limit: number;
        offset?: string;
        completedSince: string;
      }>;
    }>
  > = [];

  constructor(
    private readonly response: Result<TaskListPage, TaskReadError> = ok({
      tasks: [],
    }),
  ) {}

  async getSectionTasks(
    _token: string,
    sectionGid: string,
    options: Readonly<{
      fields: readonly string[];
      limit: number;
      offset?: string;
      completedSince: string;
    }>,
  ) {
    this.calls.push({ kind: "section", gid: sectionGid, options });
    return this.response;
  }

  async getProjectTasks(
    _token: string,
    projectGid: string,
    options: Readonly<{
      fields: readonly string[];
      limit: number;
      offset?: string;
      completedSince: string;
    }>,
  ) {
    this.calls.push({ kind: "project", gid: projectGid, options });
    return this.response;
  }
}

describe("tasks list command", () => {
  const identity = new InMemoryIdentity(ok({ gid: "9001", name: "Ada" }));

  test("lists tasks from a section and outputs a human-readable table", async () => {
    const reader = new InMemoryTaskListReader(
      ok({
        tasks: [
          {
            gid: "1",
            name: "Write docs",
            completed: false,
            assignee: { gid: "9001", name: "Ada" },
          },
        ],
      }),
    );
    const result = await execute(["tasks", "list", "--section", "500"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity,
      taskListReader: reader,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Write docs");
    expect(result.stderr).toBe("");
    expect(reader.calls).toEqual([
      {
        kind: "section",
        gid: "500",
        options: expect.objectContaining({ limit: 100 }),
      },
    ]);
  });

  test("lists tasks from a project", async () => {
    const reader = new InMemoryTaskListReader(ok({ tasks: [] }));
    const result = await execute(["tasks", "list", "--project", "600"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity,
      taskListReader: reader,
    });
    expect(result.exitCode).toBe(0);
    expect(reader.calls[0]?.kind).toBe("project");
    expect(reader.calls[0]?.gid).toBe("600");
  });

  test("outputs stable JSON data and scan metadata", async () => {
    const reader = new InMemoryTaskListReader(
      ok({
        tasks: [
          {
            gid: "1",
            name: "Write docs",
            completed: false,
            assignee: { gid: "9001", name: "Ada" },
          },
        ],
      }),
    );
    const result = await execute(
      ["--json", "tasks", "list", "--section", "500"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity,
        taskListReader: reader,
      },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      data: [
        {
          gid: "1",
          name: "Write docs",
          completed: false,
          assignee: { gid: "9001", name: "Ada" },
        },
      ],
      meta: { scanned: 1, returned: 1, scan_truncated: false },
    });
  });

  test("filters by --completed and --assignee", async () => {
    const reader = new InMemoryTaskListReader(
      ok({
        tasks: [
          {
            gid: "1",
            completed: true,
            assignee: { gid: "9001" },
          },
          {
            gid: "2",
            completed: true,
            assignee: { gid: "9002" },
          },
        ],
      }),
    );
    const result = await execute(
      [
        "--json",
        "tasks",
        "list",
        "--section",
        "500",
        "--completed",
        "true",
        "--assignee",
        "me",
      ],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity,
        taskListReader: reader,
      },
    );
    expect(JSON.parse(result.stdout).data).toEqual([
      { gid: "1", completed: true, assignee: { gid: "9001" } },
    ]);
  });

  test("warns in human output when the task scan cap is reached", async () => {
    const reader = new InMemoryTaskListReader(
      ok({
        tasks: [{ gid: "1", completed: false }],
        nextOffset: "page-2",
      }),
    );
    const result = await execute(
      ["tasks", "list", "--section", "500", "--max", "1"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity,
        taskListReader: reader,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Warning:");
    expect(result.stderr).toBe(
      "Warning: task scan cap reached; more tasks may exist.\n",
    );
  });

  test("rejects a missing or multiple source before any token read", async () => {
    const reader = new InMemoryTaskListReader();
    const noSource = await execute(["tasks", "list"], {
      environment: new Proxy(
        {},
        {
          get: () => {
            throw new Error("authentication must not be read");
          },
        },
      ),
      identity: new InMemoryIdentity(
        err({ kind: "authentication", message: "fail" }),
      ),
      taskListReader: reader,
    });
    expect(noSource.exitCode).toBe(2);

    const multipleSources = await execute(
      ["tasks", "list", "--section", "1", "--project", "2"],
      {
        environment: { ASANA_CLI_TOKEN: "valid-token" },
        identity,
        taskListReader: reader,
      },
    );
    expect(multipleSources.exitCode).toBe(2);
    expect(reader.calls).toHaveLength(0);
  });

  test("requires a task list reader dependency", async () => {
    const result = await execute(["tasks", "list", "--section", "500"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity,
    });
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("internal_error");
  });

  test("maps a not_found task list reader error", async () => {
    const failingReader: TaskListGateway = {
      getSectionTasks: async () =>
        err<TaskReadError>({
          kind: "not_found",
          status: 404,
          message: "Resource not found",
        }),
      getProjectTasks: async () =>
        err<TaskReadError>({
          kind: "not_found",
          status: 404,
          message: "Resource not found",
        }),
    };
    const result = await execute(["tasks", "list", "--section", "500"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity,
      taskListReader: failingReader,
    });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("not_found");
  });

  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  test("resolves a My Tasks section by alias via live discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "asana-cli-list-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".git"));
    await writeFile(
      join(root, ".asana-cli.json"),
      JSON.stringify({ workspace: { gid: "100" } }),
    );
    await writeFile(
      join(root, ".asana-cli.local.json"),
      JSON.stringify({
        myTasks: { userTaskListGid: "200", sections: { in_review: "300" } },
      }),
    );
    const reader = new InMemoryTaskListReader(ok({ tasks: [] }));
    const result = await execute(
      ["tasks", "list", "--my-section", "@in_review"],
      {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity,
        taskListReader: reader,
        myTaskSectionsDiscovery: new InMemoryDiscovery(
          ok({
            userTaskListGid: "200",
            sections: [{ gid: "300", name: "In Review" }],
            customFields: [],
          }),
        ),
        configuration: { cwd: root, home: join(root, "home"), environment: {} },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(reader.calls[0]).toEqual({
      kind: "section",
      gid: "300",
      options: expect.objectContaining({ limit: 100 }),
    });
  });

  test("rejects an unresolvable My Tasks alias without listing", async () => {
    const root = await mkdtemp(join(tmpdir(), "asana-cli-list-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".git"));
    await writeFile(
      join(root, ".asana-cli.json"),
      JSON.stringify({ workspace: { gid: "100" } }),
    );
    await writeFile(
      join(root, ".asana-cli.local.json"),
      JSON.stringify({
        myTasks: { userTaskListGid: "200", sections: { in_review: "300" } },
      }),
    );
    const reader = new InMemoryTaskListReader(ok({ tasks: [] }));
    const result = await execute(
      ["tasks", "list", "--my-section", "@unknown"],
      {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity,
        taskListReader: reader,
        myTaskSectionsDiscovery: new InMemoryDiscovery(
          ok({
            userTaskListGid: "200",
            sections: [{ gid: "300", name: "In Review" }],
            customFields: [],
          }),
        ),
        configuration: { cwd: root, home: join(root, "home"), environment: {} },
      },
    );
    expect(result.exitCode).toBe(2);
    expect(reader.calls).toHaveLength(0);
  });
});

describe("workspaces list command", () => {
  const identity = new InMemoryIdentity(ok({ gid: "123", name: "Ada" }));

  test("lists workspaces and renders a human-readable table", async () => {
    const reader = new InMemoryWorkspaceReader([
      ok({ workspaces: [{ gid: "1", name: "Acme" }] }),
    ]);
    const result = await execute(["workspaces", "list"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity,
      workspaceReader: reader,
    });
    expect(result).toEqual({
      stdout: "gid  name\n1    Acme\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("outputs stable JSON", async () => {
    const reader = new InMemoryWorkspaceReader([
      ok({ workspaces: [{ gid: "1", name: "Acme" }] }),
    ]);
    const result = await execute(["workspaces", "list", "--json"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity,
      workspaceReader: reader,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      '{"data":[{"gid":"1","name":"Acme"}],"meta":{}}\n',
    );
  });

  test("fetches multiple pages exactly once and combines them in API order", async () => {
    const reader = new InMemoryWorkspaceReader([
      ok({ workspaces: [{ gid: "1", name: "Acme" }], nextOffset: "page-2" }),
      ok({ workspaces: [{ gid: "2", name: "Umbrella Corp" }] }),
    ]);
    const result = await execute(["workspaces", "list", "--json"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity,
      workspaceReader: reader,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      data: [
        { gid: "1", name: "Acme" },
        { gid: "2", name: "Umbrella Corp" },
      ],
      meta: {},
    });
    expect(reader.calls).toEqual([
      { limit: 100 },
      { limit: 100, offset: "page-2" },
    ]);
  });

  test("rejects a non-advancing pagination offset instead of looping", async () => {
    const reader = new InMemoryWorkspaceReader([
      ok({ workspaces: [{ gid: "1", name: "Acme" }], nextOffset: "page-2" }),
      ok({
        workspaces: [{ gid: "2", name: "Umbrella Corp" }],
        nextOffset: "page-2",
      }),
    ]);
    const result = await execute(["workspaces", "list"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity,
      workspaceReader: reader,
    });
    expect(result.exitCode).toBe(4);
    expect(reader.calls).toHaveLength(2);
  });

  test("rejects a missing token before any reader call", async () => {
    const reader = new InMemoryWorkspaceReader([]);
    const result = await execute(["workspaces", "list"], {
      environment: {},
      identity,
      workspaceReader: reader,
    });
    expect(result.exitCode).toBe(3);
    expect(reader.calls).toHaveLength(0);
  });

  test("maps API and retry exhaustion failures to their exit codes", async () => {
    const api = await execute(["workspaces", "list"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity,
      workspaceReader: new InMemoryWorkspaceReader([
        err({ kind: "api", message: "body with secret", status: 500 }),
      ]),
    });
    expect(api.exitCode).toBe(4);
    expect(api.stderr).not.toContain("secret");

    const exhausted = await execute(["workspaces", "list"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity,
      workspaceReader: new InMemoryWorkspaceReader([
        err({ kind: "rate_limit", message: "secret", status: 429 }),
      ]),
    });
    expect(exhausted.exitCode).toBe(5);
  });

  test("fails with an internal error when the workspace reader dependency is missing", async () => {
    const result = await execute(["workspaces", "list"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity,
    });
    expect(result.exitCode).toBe(6);
  });

  test("rejects the global --fields option, which this command does not support", async () => {
    const reader = new InMemoryWorkspaceReader([]);
    const result = await execute(["workspaces", "list", "--fields", "gid"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity,
      workspaceReader: reader,
    });
    expect(result.exitCode).toBe(2);
    expect(reader.calls).toHaveLength(0);
  });

  test("does not write configuration or use any writer dependency", async () => {
    const reader = new InMemoryWorkspaceReader([
      ok({ workspaces: [{ gid: "1", name: "Acme" }] }),
    ]);
    const result = await execute(["workspaces", "list"], {
      environment: { ASANA_CLI_TOKEN: "valid-token" },
      identity,
      workspaceReader: reader,
      get configuration(): never {
        throw new Error("configuration accessed");
      },
      taskWriter: {
        updateTask: async () => {
          throw new Error("task writer called");
        },
      },
      commentWriter: {
        createTaskComment: async () => {
          throw new Error("comment writer called");
        },
      },
    });
    expect(result.exitCode).toBe(0);
  });

  test("root help lists the workspaces command and its list subcommand is discoverable", async () => {
    const rootHelp = await execute(["--help"], {
      environment: {},
      identity,
    });
    expect(rootHelp.stdout).toContain("workspaces");

    const workspacesHelp = await execute(["workspaces", "--help"], {
      environment: {},
      identity,
    });
    expect(workspacesHelp.exitCode).toBe(0);
    expect(workspacesHelp.stdout).toContain("list");
    expect(workspacesHelp.stdout).toContain(
      "list workspaces visible to the authenticated user",
    );
  });
});

describe("tasks comment --fields", () => {
  const commentIdentity = new InMemoryIdentity(
    ok({ gid: "1001", name: "Ada" }),
  );

  test.each([
    [["--fields", "gid,text", "tasks", "comment", "123", "hi"]],
    [["tasks", "comment", "123", "hi", "--fields", "gid,text"]],
  ])("forwards the selected comment fields for %o", async (argv) => {
    const writer = new InMemoryCommentWriter();
    const result = await execute(argv, {
      environment: { ASANA_CLI_TOKEN: "secret" },
      identity: commentIdentity,
      commentWriter: writer,
    });

    expect(result.exitCode).toBe(0);
    expect(writer.lastFields).toEqual(["gid", "text"]);
  });

  test("rejects malformed comment fields before writing", async () => {
    const writer = new InMemoryCommentWriter();
    const result = await execute(
      ["--fields", ",", "tasks", "comment", "123", "hi"],
      { environment: {}, identity: commentIdentity, commentWriter: writer },
    );

    expect(result.exitCode).toBe(2);
    expect(writer.lastFields).toBeUndefined();
  });
});

describe("tasks create --fields", () => {
  const creatorIdentity = new InMemoryIdentity(
    ok({ gid: "1001", name: "Ada" }),
  );

  test("passes selected fields to the creator for a subtask", async () => {
    const created = { gid: "77", name: "Child" };
    const creator = new InMemoryTaskCreator(ok(created));
    const result = await execute(
      [
        "--json",
        "--fields",
        "name",
        "tasks",
        "create",
        "--name",
        "Child",
        "--parent",
        "9",
      ],
      {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity: creatorIdentity,
        taskCreator: creator,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(creator.calls[0]?.fields).toEqual(["name"]);
    expect(JSON.parse(result.stdout).data).toEqual(created);
  });

  test("passes selected fields to the creator for a project task", async () => {
    const creator = new InMemoryTaskCreator(
      ok({ gid: "77", due_on: "2026-08-15" }),
    );
    const result = await execute(
      [
        "tasks",
        "create",
        "--name",
        "Task",
        "--project",
        "5",
        "--fields",
        "due_on",
      ],
      {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity: creatorIdentity,
        taskCreator: creator,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(creator.calls[0]?.fields).toEqual(["due_on"]);
  });

  test("passes selected fields to staged creation writes", async () => {
    const creator = new InMemoryTaskCreator(ok({ gid: "77", name: "Task" }));
    const writer = new StagedTaskWriter([ok({ gid: "77", name: "Task" })]);
    const result = await execute(
      [
        "--fields",
        "name",
        "tasks",
        "create",
        "--name",
        "Task",
        "--parent",
        "9",
        "--assignee",
        "4242",
      ],
      {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity: creatorIdentity,
        taskCreator: creator,
        taskWriter: writer,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(writer.calls[0]?.fields).toEqual(["name"]);
  });

  test("sends no fields when --fields is omitted", async () => {
    const creator = new InMemoryTaskCreator(ok({ gid: "77", name: "Task" }));
    const result = await execute(
      ["tasks", "create", "--name", "Task", "--parent", "9"],
      {
        environment: { ASANA_CLI_TOKEN: "secret" },
        identity: creatorIdentity,
        taskCreator: creator,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(creator.calls[0]?.fields).toBeUndefined();
  });

  test("rejects malformed --fields before creating anything", async () => {
    const creator = new InMemoryTaskCreator(ok({ gid: "77", name: "Task" }));
    const result = await execute(
      ["--fields", " ", "tasks", "create", "--name", "Task", "--parent", "9"],
      { environment: {}, identity: creatorIdentity, taskCreator: creator },
    );

    expect(result.exitCode).toBe(2);
    expect(creator.calls).toHaveLength(0);
  });
});

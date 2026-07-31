import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Identity,
  IdentityError,
  IdentityGateway,
} from "../identity/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import { execute } from "./index.ts";

class InMemoryIdentity implements IdentityGateway {
  constructor(private readonly response: Result<Identity, IdentityError>) {}

  async getAuthenticatedUser(): Promise<Result<Identity, IdentityError>> {
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
      stdout: `100\nsource: ${join(root, ".asana-cli.json")}\n`,
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
        `team.gid: 200 (${join(root, ".asana-cli.json")})\n` +
        `workspace.gid: 100 (${join(root, ".asana-cli.json")})\n`,
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
      data: { workspace: { gid: "100" }, team: { gid: "200" } },
      meta: {
        sources: {
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
});

import { describe, expect, test } from "bun:test";

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
    const version = await execute(["-v"], { environment: {}, identity });
    expect(version).toEqual({ stdout: "0.1.0\n", stderr: "", exitCode: 0 });

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

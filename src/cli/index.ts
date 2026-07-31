import { Command } from "commander";

import { resolveToken } from "../auth/index.ts";
import type { IdentityGateway } from "../asana/index.ts";
import { renderError, renderIdentity, renderJson } from "../output/index.ts";

export type Execution = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export type ExecuteDependencies = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  identity: IdentityGateway;
  version?: string;
}>;

const usageError = (message: string): Execution => ({
  stdout: "",
  stderr: renderError({ code: "invalid_usage", message }),
  exitCode: 2,
});

const failure = (kind: string): Execution => {
  const exitCode =
    kind === "authentication" ? 3 : kind === "rate_limit" ? 5 : 4;
  const safeMessage =
    kind === "authentication"
      ? "Asana authentication failed"
      : kind === "rate_limit"
        ? "Asana request retries exhausted"
        : kind === "network"
          ? "Unable to reach Asana"
          : kind === "invalid_response"
            ? "Asana returned an invalid response"
            : "Asana API request failed";
  return {
    stdout: "",
    stderr: renderError({ code: kind, message: safeMessage }),
    exitCode,
  };
};

export const execute = async (
  argv: readonly string[],
  dependencies: ExecuteDependencies,
): Promise<Execution> => {
  const program = new Command()
    .name("asana-cli")
    .version(dependencies.version ?? "0.1.0");
  let json = false;
  let invoked = false;
  let result: Execution | undefined;
  let parserStdout = "";
  let parserStderr = "";

  program.option("--json", "output JSON");
  program
    .command("whoami")
    .description("show the authenticated Asana user")
    .action(async () => {
      invoked = true;
      json = program.opts<{ json?: boolean }>().json ?? false;
      const token = resolveToken(dependencies.environment);
      if (!token.ok) {
        result = {
          stdout: "",
          stderr: renderError({
            code: "authentication",
            message: token.error.message,
          }),
          exitCode: 3,
        };
        return;
      }
      const identity = await dependencies.identity.getAuthenticatedUser(
        token.value,
      );
      if (!identity.ok) {
        result = failure(identity.error.kind);
        return;
      }
      result = {
        stdout: json
          ? renderJson(identity.value)
          : renderIdentity(identity.value),
        stderr: "",
        exitCode: 0,
      };
    });

  if (argv.includes("--help") || argv.includes("-h")) {
    return { stdout: program.helpInformation(), stderr: "", exitCode: 0 };
  }

  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => {
      parserStdout += text;
    },
    writeErr: (text) => {
      parserStderr += text;
    },
  });
  try {
    await program.parseAsync(["bun", "asana-cli", ...argv], { from: "node" });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "commander.helpDisplayed"
    ) {
      return { stdout: parserStdout, stderr: "", exitCode: 0 };
    }
    const message = error instanceof Error ? error.message : "Invalid command";
    return {
      ...usageError(message),
      stderr: parserStderr || usageError(message).stderr,
    };
  }
  return (
    result ??
    (invoked
      ? usageError("Command did not complete")
      : usageError("A command is required"))
  );
};

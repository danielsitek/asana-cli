import { Command, CommanderError } from "commander";

import { resolveToken } from "../auth/index.ts";
import type {
  IdentityError as AsanaError,
  IdentityGateway,
} from "../identity/index.ts";
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

const identityFailures: Readonly<
  Record<AsanaError["kind"], Readonly<{ exitCode: number; message: string }>>
> = {
  authentication: { exitCode: 3, message: "Asana authentication failed" },
  api: { exitCode: 4, message: "Asana API request failed" },
  rate_limit: { exitCode: 5, message: "Asana request retries exhausted" },
  network: { exitCode: 4, message: "Unable to reach Asana" },
  invalid_response: {
    exitCode: 4,
    message: "Asana returned an invalid response",
  },
};

const renderIdentityFailure = (kind: AsanaError["kind"]): Execution => {
  const mapped = identityFailures[kind];
  return {
    stdout: "",
    stderr: renderError({ code: kind, message: mapped.message }),
    exitCode: mapped.exitCode,
  };
};

export const execute = async (
  argv: readonly string[],
  dependencies: ExecuteDependencies,
): Promise<Execution> => {
  const program = new Command()
    .name("asana-cli")
    .version(dependencies.version ?? "0.1.0", "-v, --version");
  const version = dependencies.version ?? "0.1.0";
  let json = false;
  let invoked = false;
  let result: Execution | undefined;
  let parserStdout = "";

  const captureOutput = {
    writeOut: (text: string) => {
      parserStdout += text;
    },
    writeErr: () => undefined,
  };

  program.option("--json", "output JSON");
  const whoami = program
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
        result = renderIdentityFailure(identity.error.kind);
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
  whoami.version(version, "-v, --version");

  program.exitOverride();
  program.configureOutput(captureOutput);
  whoami.exitOverride();
  whoami.configureOutput(captureOutput);
  try {
    await program.parseAsync(["bun", "asana-cli", ...argv], { from: "node" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        return { stdout: parserStdout, stderr: "", exitCode: 0 };
      }
      return usageError("Invalid command usage");
    }
    return {
      stdout: "",
      stderr: renderError({
        code: "internal_error",
        message: "An unexpected internal error occurred",
      }),
      exitCode: 6,
    };
  }
  return (
    result ??
    (invoked
      ? usageError("Command did not complete")
      : usageError("A command is required"))
  );
};

import { Command, CommanderError } from "commander";

import { resolveToken } from "../auth/index.ts";
import {
  getConfigValue,
  initializeSharedConfig,
  resolveConfig,
  setConfigValue,
  type ConfigContext,
  type ConfigError,
  type ConfigLayer,
} from "../config/index.ts";
import type {
  IdentityError as AsanaError,
  IdentityGateway,
} from "../identity/index.ts";
import {
  renderConfig,
  renderConfigValue,
  renderError,
  renderIdentity,
  renderJson,
} from "../output/index.ts";
import type { Result } from "../shared/result.ts";

export type Execution = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export type ExecuteDependencies = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  identity: IdentityGateway;
  configuration?: ConfigContext;
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

const renderConfigFailure = (error: ConfigError): Execution => ({
  stdout: "",
  stderr: renderError({ code: "configuration", message: error.message }),
  exitCode: 2,
});

const selectedLayer = (
  options: Readonly<{
    shared?: boolean;
    local?: boolean;
    global?: boolean;
  }>,
): Result<ConfigLayer | undefined, string> => {
  const selected = (
    [
      ["shared", options.shared],
      ["local", options.local],
      ["global", options.global],
    ] as const
  ).filter(([, enabled]) => enabled);
  return selected.length > 1
    ? {
        ok: false,
        error: "--shared, --local, and --global are mutually exclusive",
      }
    : { ok: true, value: selected[0]?.[0] };
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

  const beginConfigCommand = (): ConfigContext | undefined => {
    invoked = true;
    json = program.opts<{ json?: boolean }>().json ?? false;
    const context = dependencies.configuration;
    if (!context) result = usageError("Configuration context is unavailable");
    return context;
  };

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

  const config = program
    .command("config")
    .description("manage layered configuration");

  config
    .command("init")
    .description("initialize configuration")
    .option("--shared", "initialize shared repository configuration")
    .option("--workspace <gid>", "Asana workspace GID")
    .action(
      async (options: Readonly<{ shared?: boolean; workspace?: string }>) => {
        const context = beginConfigCommand();
        if (!context) return;
        if (!options.shared) {
          result = usageError("config init currently requires --shared");
          return;
        }
        const initialized = await initializeSharedConfig(
          context,
          options.workspace,
        );
        if (!initialized.ok) {
          result = renderConfigFailure(initialized.error);
          return;
        }
        result = {
          stdout: json
            ? renderJson(initialized.value)
            : `initialized ${initialized.value.path}\n`,
          stderr: "",
          exitCode: 0,
        };
      },
    );

  config
    .command("get")
    .description("read an effective configuration value")
    .argument("<key>", "dotted configuration key")
    .option("--source", "include the winning source")
    .action(async (key: string, options: Readonly<{ source?: boolean }>) => {
      const context = beginConfigCommand();
      if (!context) return;
      const resolved = await resolveConfig(context);
      if (!resolved.ok) {
        result = renderConfigFailure(resolved.error);
        return;
      }
      const found = getConfigValue(resolved.value, key);
      if (!found.ok) {
        result = renderConfigFailure(found.error);
        return;
      }
      result = {
        stdout: renderConfigValue(
          found.value.value,
          options.source ? found.value.source : undefined,
          options.source ? found.value.sources : {},
          json,
        ),
        stderr: "",
        exitCode: 0,
      };
    });

  config
    .command("set")
    .description("write a configuration value")
    .argument("<key>", "dotted configuration key")
    .argument("<value>", "configuration value")
    .option("--shared", "write shared repository configuration")
    .option("--local", "write personal repository configuration")
    .option("--global", "write global user configuration")
    .action(
      async (
        key: string,
        value: string,
        options: Readonly<{
          shared?: boolean;
          local?: boolean;
          global?: boolean;
        }>,
      ) => {
        const context = beginConfigCommand();
        if (!context) return;
        const layer = selectedLayer(options);
        if (!layer.ok) {
          result = usageError(layer.error);
          return;
        }
        const written = await setConfigValue(context, key, value, layer.value);
        if (!written.ok) {
          result = renderConfigFailure(written.error);
          return;
        }
        result = {
          stdout: json
            ? renderJson(written.value)
            : `updated ${written.value.path}\n`,
          stderr: "",
          exitCode: 0,
        };
      },
    );

  config
    .command("show")
    .description("show effective configuration")
    .option("--sources", "include the winning source for every value")
    .action(async (options: Readonly<{ sources?: boolean }>) => {
      const context = beginConfigCommand();
      if (!context) return;
      const resolved = await resolveConfig(context);
      if (!resolved.ok) {
        result = renderConfigFailure(resolved.error);
        return;
      }
      result = {
        stdout: renderConfig(
          resolved.value.value,
          resolved.value.sources,
          options.sources ?? false,
          json,
        ),
        stderr: "",
        exitCode: 0,
      };
    });

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

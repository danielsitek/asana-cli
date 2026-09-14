import type { Command } from "commander";

import {
  getConfigValue,
  initializeLocalConfig,
  initializeSharedConfig,
  resolveConfig,
  setConfigValue,
  type ConfigContext,
  type ConfigError,
  type ConfigLayer,
  type LocalConfigInitResult,
  type StageFailureError,
} from "../config/index.ts";
import type { IdentityError } from "../identity/index.ts";
import {
  renderConfig,
  renderConfigValue,
  renderError,
  renderJson,
  renderResolvedMyTasks,
} from "../output/index.ts";
import type { Result } from "../shared/result.ts";
import type { ExecuteDependencies, Execution } from "./contracts.ts";

type ConfigCommandDependencies = Pick<ExecuteDependencies, "discovery">;

type ConfigInvocation = Readonly<{
  context: ConfigContext;
  json: boolean;
}>;

type ConfigCommandRegistration = Readonly<{
  program: Command;
  dependencies: ConfigCommandDependencies;
  beginCommand: () => ConfigInvocation | undefined;
  complete: (execution: Execution) => void;
  requireToken: () => Result<string, Execution>;
  renderIdentityFailure: (kind: IdentityError["kind"]) => Execution;
  usageError: (message: string) => Execution;
}>;

const renderConfigFailure = (error: ConfigError): Execution => ({
  stdout: "",
  stderr: renderError({ code: "configuration", message: error.message }),
  exitCode: 2,
});

const renderStageFailure = (
  error: StageFailureError,
  json: boolean,
): Execution => {
  if (json) {
    return {
      stdout: renderJson({
        completed: error.completed,
        failed: error.failed,
        message: error.message,
      }),
      stderr: "",
      exitCode: 1,
    };
  }

  const completedList = [...error.completed].sort().join(", ");
  const failedList = [...error.failed].sort().join(", ");
  return {
    stdout: `Stage failure: ${error.message}\nCompleted: ${completedList || "none"}\nFailed: ${failedList || "none"}\n`,
    stderr: "",
    exitCode: 1,
  };
};

const requireConfig = async (
  context: ConfigContext,
  dependencies: ConfigCommandDependencies,
  requireToken: () => Result<string, Execution>,
  renderIdentityFailure: (kind: IdentityError["kind"]) => Execution,
  options: Readonly<{ writeGitignore?: boolean }>,
  json: boolean,
): Promise<Result<LocalConfigInitResult, Execution>> => {
  const token = requireToken();
  if (!token.ok) return token;

  const discovery = dependencies.discovery;
  if (!discovery) {
    return {
      ok: false,
      error: {
        stdout: "",
        stderr: renderError({
          code: "internal_error",
          message: "Discovery gateway is required",
        }),
        exitCode: 6,
      },
    };
  }

  const initialized = await initializeLocalConfig(
    context,
    token.value,
    discovery,
    options,
  );
  if (initialized.ok) return initialized;
  if (initialized.error.kind === "configuration") {
    return { ok: false, error: renderConfigFailure(initialized.error) };
  }
  if (initialized.error.kind === "stage_failure") {
    return { ok: false, error: renderStageFailure(initialized.error, json) };
  }
  return {
    ok: false,
    error: renderIdentityFailure(initialized.error.kind),
  };
};

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

export const registerConfigCommands = ({
  program,
  dependencies,
  beginCommand,
  complete,
  requireToken,
  renderIdentityFailure,
  usageError,
}: ConfigCommandRegistration): void => {
  const config = program
    .command("config")
    .description("manage layered configuration");

  config
    .command("init")
    .description("initialize configuration")
    .option("--shared", "initialize shared repository configuration")
    .option("--local", "initialize local repository configuration")
    .option("--workspace <gid>", "Asana workspace GID")
    .option(
      "--write-gitignore",
      "automatically ignore the local configuration file",
    )
    .action(
      async (
        options: Readonly<{
          shared?: boolean;
          local?: boolean;
          workspace?: string;
          writeGitignore?: boolean;
        }>,
      ) => {
        const invocation = beginCommand();
        if (!invocation) return;
        const { context, json } = invocation;

        if (options.shared && options.local) {
          complete(usageError("--shared and --local are mutually exclusive"));
          return;
        }
        if (!options.shared && !options.local) {
          complete(
            usageError("config init requires either --shared or --local"),
          );
          return;
        }
        if (options.writeGitignore && !options.local) {
          complete(usageError("--write-gitignore requires --local"));
          return;
        }
        if (options.local && options.workspace !== undefined) {
          complete(usageError("--workspace is not supported with --local"));
          return;
        }

        if (options.shared) {
          const initialized = await initializeSharedConfig(
            context,
            options.workspace,
          );
          if (!initialized.ok) {
            complete(renderConfigFailure(initialized.error));
            return;
          }
          complete({
            stdout: json
              ? renderJson(initialized.value)
              : `initialized ${initialized.value.path}\n`,
            stderr: "",
            exitCode: 0,
          });
          return;
        }

        const initialized = await requireConfig(
          context,
          dependencies,
          requireToken,
          renderIdentityFailure,
          options.writeGitignore !== undefined
            ? { writeGitignore: options.writeGitignore }
            : {},
          json,
        );
        if (!initialized.ok) {
          complete(initialized.error);
          return;
        }

        complete({
          stdout: json
            ? renderJson(initialized.value)
            : `initialized ${initialized.value.path}\n`,
          stderr: "",
          exitCode: 0,
        });
      },
    );

  const resolveCmd = config
    .command("resolve")
    .description("resolve configuration resources");

  resolveCmd
    .command("my-tasks")
    .description("resolve My Tasks configuration")
    .action(async () => {
      const invocation = beginCommand();
      if (!invocation) return;
      const { context, json } = invocation;

      const resolved = await requireConfig(
        context,
        dependencies,
        requireToken,
        renderIdentityFailure,
        {},
        json,
      );
      if (!resolved.ok) {
        complete(resolved.error);
        return;
      }

      complete({
        stdout: json
          ? renderJson(resolved.value.myTasks)
          : renderResolvedMyTasks(resolved.value.myTasks),
        stderr: "",
        exitCode: 0,
      });
    });

  config
    .command("get")
    .description("read an effective configuration value")
    .argument("<key>", "dotted configuration key")
    .option("--source", "include the winning source")
    .action(async (key: string, options: Readonly<{ source?: boolean }>) => {
      const invocation = beginCommand();
      if (!invocation) return;
      const { context, json } = invocation;

      const resolved = await resolveConfig(context);
      if (!resolved.ok) {
        complete(renderConfigFailure(resolved.error));
        return;
      }
      const found = getConfigValue(resolved.value, key);
      if (!found.ok) {
        complete(renderConfigFailure(found.error));
        return;
      }
      complete({
        stdout: renderConfigValue(
          found.value.value,
          options.source ? found.value.source : undefined,
          options.source ? found.value.sources : {},
          json,
        ),
        stderr: "",
        exitCode: 0,
      });
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
        const invocation = beginCommand();
        if (!invocation) return;
        const { context, json } = invocation;

        const layer = selectedLayer(options);
        if (!layer.ok) {
          complete(usageError(layer.error));
          return;
        }
        const written = await setConfigValue(context, key, value, layer.value);
        if (!written.ok) {
          complete(renderConfigFailure(written.error));
          return;
        }
        complete({
          stdout: json
            ? renderJson(written.value)
            : `updated ${written.value.path}\n`,
          stderr: "",
          exitCode: 0,
        });
      },
    );

  config
    .command("show")
    .description("show effective configuration")
    .option("--sources", "include the winning source for every value")
    .action(async (options: Readonly<{ sources?: boolean }>) => {
      const invocation = beginCommand();
      if (!invocation) return;
      const { context, json } = invocation;

      const resolved = await resolveConfig(context);
      if (!resolved.ok) {
        complete(renderConfigFailure(resolved.error));
        return;
      }
      complete({
        stdout: renderConfig(
          resolved.value.value,
          resolved.value.sources,
          options.sources ?? false,
          json,
        ),
        stderr: "",
        exitCode: 0,
      });
    });
};

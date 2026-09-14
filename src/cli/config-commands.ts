import type { Command } from "commander";

import {
  getConfigValue,
  initializeLocalConfig,
  initializeSharedConfig,
  resolveConfig,
  setConfigValue,
  type ConfigContext,
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
import { renderConfigFailure } from "./config-error.ts";
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

type ConfigInitOptions = Readonly<{
  shared?: boolean;
  local?: boolean;
  workspace?: string;
  writeGitignore?: boolean;
}>;

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

const validateConfigInitOptions = (
  options: ConfigInitOptions,
): string | undefined => {
  if (options.shared && options.local) {
    return "--shared and --local are mutually exclusive";
  }
  if (!options.shared && !options.local) {
    return "config init requires either --shared or --local";
  }
  if (options.writeGitignore && !options.local) {
    return "--write-gitignore requires --local";
  }
  return options.local && options.workspace !== undefined
    ? "--workspace is not supported with --local"
    : undefined;
};

const renderInitialized = (
  initialized: Readonly<{ path?: string }>,
  json: boolean,
): Execution => ({
  stdout: json ? renderJson(initialized) : `initialized ${initialized.path}\n`,
  stderr: "",
  exitCode: 0,
});

const runSharedConfigInit = async (
  context: ConfigContext,
  workspace: string | undefined,
  json: boolean,
): Promise<Execution> => {
  const initialized = await initializeSharedConfig(context, workspace);
  return initialized.ok
    ? renderInitialized(initialized.value, json)
    : renderConfigFailure(initialized.error);
};

const runLocalConfigInit = async (
  context: ConfigContext,
  options: ConfigInitOptions,
  json: boolean,
  registration: ConfigCommandRegistration,
): Promise<Execution> => {
  const initialized = await requireConfig(
    context,
    registration.dependencies,
    registration.requireToken,
    registration.renderIdentityFailure,
    options.writeGitignore !== undefined
      ? { writeGitignore: options.writeGitignore }
      : {},
    json,
  );
  return initialized.ok
    ? renderInitialized(initialized.value, json)
    : initialized.error;
};

const runConfigInit = async (
  options: ConfigInitOptions,
  registration: ConfigCommandRegistration,
): Promise<void> => {
  const invocation = registration.beginCommand();
  if (!invocation) return;

  const validationError = validateConfigInitOptions(options);
  if (validationError) {
    registration.complete(registration.usageError(validationError));
    return;
  }

  const execution = options.shared
    ? await runSharedConfigInit(
        invocation.context,
        options.workspace,
        invocation.json,
      )
    : await runLocalConfigInit(
        invocation.context,
        options,
        invocation.json,
        registration,
      );
  registration.complete(execution);
};

const registerConfigInit = (
  config: Command,
  registration: ConfigCommandRegistration,
): void => {
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
    .action((options: ConfigInitOptions) =>
      runConfigInit(options, registration),
    );
};

const runConfigResolve = async (
  registration: ConfigCommandRegistration,
): Promise<void> => {
  const invocation = registration.beginCommand();
  if (!invocation) return;

  const resolved = await requireConfig(
    invocation.context,
    registration.dependencies,
    registration.requireToken,
    registration.renderIdentityFailure,
    {},
    invocation.json,
  );
  if (!resolved.ok) {
    registration.complete(resolved.error);
    return;
  }

  registration.complete({
    stdout: invocation.json
      ? renderJson(resolved.value.myTasks)
      : renderResolvedMyTasks(resolved.value.myTasks),
    stderr: "",
    exitCode: 0,
  });
};

const registerConfigResolve = (
  config: Command,
  registration: ConfigCommandRegistration,
): void => {
  config
    .command("resolve")
    .description("resolve configuration resources")
    .command("my-tasks")
    .description("resolve My Tasks configuration")
    .action(() => runConfigResolve(registration));
};

const runConfigGet = async (
  key: string,
  options: Readonly<{ source?: boolean }>,
  registration: ConfigCommandRegistration,
): Promise<void> => {
  const invocation = registration.beginCommand();
  if (!invocation) return;

  const resolved = await resolveConfig(invocation.context);
  if (!resolved.ok) {
    registration.complete(renderConfigFailure(resolved.error));
    return;
  }
  const found = getConfigValue(resolved.value, key);
  if (!found.ok) {
    registration.complete(renderConfigFailure(found.error));
    return;
  }
  registration.complete({
    stdout: renderConfigValue(
      found.value.value,
      options.source ? found.value.source : undefined,
      options.source ? found.value.sources : {},
      invocation.json,
    ),
    stderr: "",
    exitCode: 0,
  });
};

const registerConfigGet = (
  config: Command,
  registration: ConfigCommandRegistration,
): void => {
  config
    .command("get")
    .description("read an effective configuration value")
    .argument("<key>", "dotted configuration key")
    .option("--source", "include the winning source")
    .action((key: string, options: Readonly<{ source?: boolean }>) =>
      runConfigGet(key, options, registration),
    );
};

const runConfigSet = async (
  key: string,
  value: string,
  options: Readonly<{ shared?: boolean; local?: boolean; global?: boolean }>,
  registration: ConfigCommandRegistration,
): Promise<void> => {
  const invocation = registration.beginCommand();
  if (!invocation) return;

  const layer = selectedLayer(options);
  if (!layer.ok) {
    registration.complete(registration.usageError(layer.error));
    return;
  }
  const written = await setConfigValue(
    invocation.context,
    key,
    value,
    layer.value,
  );
  if (!written.ok) {
    registration.complete(renderConfigFailure(written.error));
    return;
  }
  registration.complete({
    stdout: invocation.json
      ? renderJson(written.value)
      : `updated ${written.value.path}\n`,
    stderr: "",
    exitCode: 0,
  });
};

const registerConfigSet = (
  config: Command,
  registration: ConfigCommandRegistration,
): void => {
  config
    .command("set")
    .description("write a configuration value")
    .argument("<key>", "dotted configuration key")
    .argument("<value>", "configuration value")
    .option("--shared", "write shared repository configuration")
    .option("--local", "write personal repository configuration")
    .option("--global", "write global user configuration")
    .action(
      (
        key: string,
        value: string,
        options: Readonly<{
          shared?: boolean;
          local?: boolean;
          global?: boolean;
        }>,
      ) => runConfigSet(key, value, options, registration),
    );
};

const runConfigShow = async (
  options: Readonly<{ sources?: boolean }>,
  registration: ConfigCommandRegistration,
): Promise<void> => {
  const invocation = registration.beginCommand();
  if (!invocation) return;

  const resolved = await resolveConfig(invocation.context);
  if (!resolved.ok) {
    registration.complete(renderConfigFailure(resolved.error));
    return;
  }
  registration.complete({
    stdout: renderConfig(
      resolved.value.value,
      resolved.value.sources,
      options.sources ?? false,
      invocation.json,
    ),
    stderr: "",
    exitCode: 0,
  });
};

const registerConfigShow = (
  config: Command,
  registration: ConfigCommandRegistration,
): void => {
  config
    .command("show")
    .description("show effective configuration")
    .option("--sources", "include the winning source for every value")
    .action((options: Readonly<{ sources?: boolean }>) =>
      runConfigShow(options, registration),
    );
};

export const registerConfigCommands = (
  registration: ConfigCommandRegistration,
): void => {
  const config = registration.program
    .command("config")
    .description("manage layered configuration");

  registerConfigInit(config, registration);
  registerConfigResolve(config, registration);
  registerConfigGet(config, registration);
  registerConfigSet(config, registration);
  registerConfigShow(config, registration);
};

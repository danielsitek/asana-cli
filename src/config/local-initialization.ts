import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { err, ok, type Result } from "../shared/result.ts";
import { localConfigIsIgnored } from "./gitignore.ts";
import type { ConfigContext, ConfigError, ResolvedConfig } from "./index.ts";

type JsonObject = Record<string, unknown>;

type LocalConfigServices = Readonly<{
  resolveConfig: (
    context: ConfigContext,
  ) => Promise<Result<ResolvedConfig, ConfigError>>;
  readLocalConfig: (path: string) => Promise<Result<JsonObject, ConfigError>>;
  validateLocalConfig: (
    path: string,
    value: unknown,
  ) => Result<JsonObject, ConfigError>;
  targetLocalPath: (
    resolvedConfig: ResolvedConfig,
  ) => Result<string, ConfigError>;
  stageWrite: (path: string, content: string) => Promise<void>;
  cleanupTempFiles: (paths: readonly string[]) => Promise<void>;
}>;

const generateAlias = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
};

const codeUnitCompare = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

export type DiscoveredSection = Readonly<{
  gid: string;
  name: string;
}>;

export type DiscoveredEnumOption = Readonly<{
  gid: string;
  name: string;
  enabled: boolean;
}>;

type DiscoveredCustomFieldBase = Readonly<{
  gid: string;
  name: string;
  isReadOnly: boolean;
}>;

export type DiscoveredCustomField =
  | (DiscoveredCustomFieldBase & Readonly<{ resourceSubtype: "number" }>)
  | (DiscoveredCustomFieldBase &
      Readonly<{
        resourceSubtype: "enum";
        enumOptions: readonly DiscoveredEnumOption[];
      }>)
  | (DiscoveredCustomFieldBase &
      Readonly<{
        resourceSubtype: "unsupported";
        originalResourceSubtype: string;
      }>);

export type DiscoveredMyTasks = Readonly<{
  userTaskListGid: string;
  sections: readonly DiscoveredSection[];
  customFields: readonly DiscoveredCustomField[];
}>;

export type DiscoveredMyTaskSections = Pick<
  DiscoveredMyTasks,
  "userTaskListGid" | "sections"
>;

export type DiscoveryError = Readonly<{
  kind:
    | "authentication"
    | "api"
    | "rate_limit"
    | "network"
    | "invalid_response";
  message: string;
  status?: number;
}>;

export interface MyTasksDiscoveryGateway {
  discoverMyTasks(
    token: string,
    workspaceGid: string,
  ): Promise<Result<DiscoveredMyTasks, DiscoveryError>>;
}

export interface MyTaskSectionsDiscoveryGateway {
  discoverMyTaskSections(
    token: string,
    workspaceGid: string,
  ): Promise<Result<DiscoveredMyTaskSections, DiscoveryError>>;
}

export type LocalConfigInitResult = Readonly<{
  layer: "local";
  path: string;
  myTasks: {
    userTaskListGid: string;
    sections: Record<string, string>;
    customFields: Record<string, string>;
  };
}>;

export type StageFailureError = Readonly<{
  kind: "stage_failure";
  message: string;
  completed: readonly string[];
  failed: readonly string[];
}>;

type LocalConfigInitError = ConfigError | DiscoveryError | StageFailureError;

type ConfigFileOperations = NonNullable<ConfigContext["fileOperations"]>;

type LocalConfigFileOperations = Readonly<{
  renameFile: NonNullable<ConfigFileOperations["rename"]>;
  stageFile: NonNullable<ConfigFileOperations["stageWrite"]>;
}>;

type LocalConfigEnvironment = Readonly<{
  resolvedConfig: ResolvedConfig;
  gitRoot: string;
  workspaceGid: string;
  shouldWriteGitignore: boolean;
  fileOperations: LocalConfigFileOperations;
  services: LocalConfigServices;
}>;

const resolveLocalConfigFileOperations = (
  context: ConfigContext,
  services: LocalConfigServices,
): LocalConfigFileOperations => ({
  renameFile: context.fileOperations?.rename ?? rename,
  stageFile: context.fileOperations?.stageWrite ?? services.stageWrite,
});

const prepareLocalConfigEnvironment = async (
  context: ConfigContext,
  writeGitignore: boolean,
  services: LocalConfigServices,
): Promise<Result<LocalConfigEnvironment, ConfigError>> => {
  const resolvedConfigResult = await services.resolveConfig(context);
  if (!resolvedConfigResult.ok) return resolvedConfigResult;
  const resolvedConfig = resolvedConfigResult.value;

  const gitRoot = resolvedConfig.paths.gitRoot;
  if (!gitRoot) {
    return err({
      kind: "configuration",
      message: "local configuration requires a git repository",
    });
  }

  const isIgnored = await localConfigIsIgnored(gitRoot);
  if (!isIgnored && !writeGitignore) {
    return err({
      kind: "configuration",
      message:
        "local configuration is not ignored by the repository .gitignore",
    });
  }

  const workspaceGid = resolvedConfig.value.workspace?.gid;
  if (!workspaceGid) {
    return err({
      kind: "configuration",
      message:
        "workspace.gid is required in configuration before initialization",
    });
  }

  return ok({
    resolvedConfig,
    gitRoot,
    workspaceGid,
    shouldWriteGitignore: !isIgnored,
    fileOperations: resolveLocalConfigFileOperations(context, services),
    services,
  });
};

type AliasResource = Readonly<{ gid: string; name: string }>;

const buildAliasMap = (
  resources: readonly AliasResource[],
  resourceLabel: "section" | "custom field",
): Result<Record<string, string>, ConfigError> => {
  const aliases: Record<string, string> = {};
  for (const resource of resources) {
    const alias = generateAlias(resource.name);
    if (!alias) {
      return err({
        kind: "configuration",
        message: `Generated alias is empty for ${resourceLabel} "${resource.name}"`,
      });
    }
    if (Object.hasOwn(aliases, alias)) {
      return err({
        kind: "configuration",
        message: `Colliding alias "${alias}" generated for ${resourceLabel} "${resource.name}"`,
      });
    }
    aliases[alias] = resource.gid;
  }
  return ok(aliases);
};

const sortAliasMap = (
  aliases: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(aliases).sort(([a], [b]) => codeUnitCompare(a, b)),
  );

const prepareDiscoveredMyTasks = (
  discovered: DiscoveredMyTasks,
): Result<LocalConfigInitResult["myTasks"], ConfigError> => {
  const sections = buildAliasMap(discovered.sections, "section");
  if (!sections.ok) return sections;

  const writableFields = discovered.customFields.filter(
    (field) =>
      (field.resourceSubtype === "number" ||
        field.resourceSubtype === "enum") &&
      !field.isReadOnly,
  );
  const customFields = buildAliasMap(writableFields, "custom field");
  if (!customFields.ok) return customFields;

  return ok({
    userTaskListGid: discovered.userTaskListGid,
    sections: sortAliasMap(sections.value),
    customFields: sortAliasMap(customFields.value),
  });
};

type PreparedLocalConfig = Readonly<{
  path: string;
  value: JsonObject;
  myTasks: LocalConfigInitResult["myTasks"];
}>;

const prepareLocalConfigValue = async (
  resolvedConfig: ResolvedConfig,
  myTasks: LocalConfigInitResult["myTasks"],
  services: LocalConfigServices,
): Promise<Result<PreparedLocalConfig, ConfigError>> => {
  const pathResult = services.targetLocalPath(resolvedConfig);
  if (!pathResult.ok) return pathResult;
  const existingLocal = await services.readLocalConfig(pathResult.value);
  if (!existingLocal.ok) return existingLocal;

  const validated = services.validateLocalConfig(pathResult.value, {
    ...existingLocal.value,
    myTasks,
  });
  if (!validated.ok) return validated;
  return ok({ path: pathResult.value, value: validated.value, myTasks });
};

const isUnexpectedGitignoreReadError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code !== "ENOENT";

const readGitignoreContent = async (
  gitignorePath: string,
): Promise<Result<string, ConfigError>> => {
  try {
    return ok(await readFile(gitignorePath, "utf8"));
  } catch (error) {
    return isUnexpectedGitignoreReadError(error)
      ? err({
          kind: "configuration",
          message: `${gitignorePath}: could not be read`,
        })
      : ok("");
  }
};

const appendLocalConfigIgnoreRule = (currentContent: string): string => {
  const separator =
    currentContent.length > 0 && !currentContent.endsWith("\n") ? "\n" : "";
  return `${currentContent}${separator}/.asana-cli.local.json\n`;
};

type StagedGitignore = Readonly<{
  path: string;
  temporaryPath: string;
}>;

const stageGitignore = async (
  gitRoot: string,
  stageFile: LocalConfigFileOperations["stageFile"],
  cleanupTempFiles: LocalConfigServices["cleanupTempFiles"],
): Promise<Result<StagedGitignore, ConfigError>> => {
  const path = join(gitRoot, ".gitignore");
  const content = await readGitignoreContent(path);
  if (!content.ok) return content;

  const temporaryPath = join(gitRoot, `.gitignore.${randomUUID()}.tmp`);
  try {
    await stageFile(temporaryPath, appendLocalConfigIgnoreRule(content.value));
    return ok({ path, temporaryPath });
  } catch {
    await cleanupTempFiles([temporaryPath]);
    return err({
      kind: "configuration",
      message: `${path}: could not be written`,
    });
  }
};

const stageLocalConfig = async (
  localConfig: PreparedLocalConfig,
  stageFile: LocalConfigFileOperations["stageFile"],
  priorTemporaryPaths: readonly string[],
  cleanupTempFiles: LocalConfigServices["cleanupTempFiles"],
): Promise<Result<string, ConfigError>> => {
  const temporaryPath = join(
    dirname(localConfig.path),
    `.asana-cli.local.json.${randomUUID()}.tmp`,
  );
  try {
    await stageFile(
      temporaryPath,
      `${JSON.stringify(localConfig.value, null, 2)}\n`,
    );
    return ok(temporaryPath);
  } catch {
    await cleanupTempFiles([...priorTemporaryPaths, temporaryPath]);
    return err({
      kind: "configuration",
      message: `${localConfig.path}: could not be written`,
    });
  }
};

const untrackTemporaryPath = (paths: string[], path: string): void => {
  const index = paths.indexOf(path);
  if (index !== -1) paths.splice(index, 1);
};

const commitLocalConfigFiles = async (
  localConfigPath: string,
  temporaryLocalConfigPath: string,
  stagedGitignore: StagedGitignore | undefined,
  renameFile: LocalConfigFileOperations["renameFile"],
  cleanupTempFiles: LocalConfigServices["cleanupTempFiles"],
): Promise<Result<void, ConfigError | StageFailureError>> => {
  const temporaryPaths = [
    ...(stagedGitignore ? [stagedGitignore.temporaryPath] : []),
    temporaryLocalConfigPath,
  ];

  if (stagedGitignore) {
    try {
      await renameFile(stagedGitignore.temporaryPath, stagedGitignore.path);
      untrackTemporaryPath(temporaryPaths, stagedGitignore.temporaryPath);
    } catch {
      await cleanupTempFiles(temporaryPaths);
      return err({
        kind: "configuration",
        message: `${stagedGitignore.path}: could not be renamed`,
      });
    }
  }

  try {
    await renameFile(temporaryLocalConfigPath, localConfigPath);
    untrackTemporaryPath(temporaryPaths, temporaryLocalConfigPath);
    return ok(undefined);
  } catch {
    await cleanupTempFiles(temporaryPaths);
    return stagedGitignore
      ? err({
          kind: "stage_failure",
          message: `${localConfigPath}: could not be renamed after writing ${stagedGitignore.path}`,
          completed: ["gitignore"],
          failed: ["local_config"],
        })
      : err({
          kind: "configuration",
          message: `${localConfigPath}: could not be renamed`,
        });
  }
};

const writeLocalConfigFiles = async (
  environment: LocalConfigEnvironment,
  localConfig: PreparedLocalConfig,
): Promise<Result<void, ConfigError | StageFailureError>> => {
  let stagedGitignore: StagedGitignore | undefined;
  if (environment.shouldWriteGitignore) {
    const staged = await stageGitignore(
      environment.gitRoot,
      environment.fileOperations.stageFile,
      environment.services.cleanupTempFiles,
    );
    if (!staged.ok) return staged;
    stagedGitignore = staged.value;
  }

  const priorTemporaryPaths = stagedGitignore
    ? [stagedGitignore.temporaryPath]
    : [];
  const stagedLocalConfig = await stageLocalConfig(
    localConfig,
    environment.fileOperations.stageFile,
    priorTemporaryPaths,
    environment.services.cleanupTempFiles,
  );
  if (!stagedLocalConfig.ok) return stagedLocalConfig;

  return commitLocalConfigFiles(
    localConfig.path,
    stagedLocalConfig.value,
    stagedGitignore,
    environment.fileOperations.renameFile,
    environment.services.cleanupTempFiles,
  );
};

export const initializeLocalConfigWorkflow = async (
  context: ConfigContext,
  token: string,
  discovery: MyTasksDiscoveryGateway,
  options: { writeGitignore?: boolean },
  services: LocalConfigServices,
): Promise<Result<LocalConfigInitResult, LocalConfigInitError>> => {
  const environment = await prepareLocalConfigEnvironment(
    context,
    options.writeGitignore === true,
    services,
  );
  if (!environment.ok) return environment;

  const discoveryResult = await discovery.discoverMyTasks(
    token,
    environment.value.workspaceGid,
  );
  if (!discoveryResult.ok) return discoveryResult;

  const myTasks = prepareDiscoveredMyTasks(discoveryResult.value);
  if (!myTasks.ok) return myTasks;
  const localConfig = await prepareLocalConfigValue(
    environment.value.resolvedConfig,
    myTasks.value,
    services,
  );
  if (!localConfig.ok) return localConfig;
  const written = await writeLocalConfigFiles(
    environment.value,
    localConfig.value,
  );
  if (!written.ok) return written;

  return ok({
    layer: "local",
    path: localConfig.value.path,
    myTasks: localConfig.value.myTasks,
  });
};

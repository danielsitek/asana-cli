import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import { z } from "zod";

import { err, ok, type Result } from "../shared/result.ts";
import { localConfigIsIgnored } from "./gitignore.ts";
import {
  initializeLocalConfigWorkflow,
  type MyTasksDiscoveryGateway,
} from "./local-initialization.ts";

export type {
  DiscoveredCustomField,
  DiscoveredEnumOption,
  DiscoveredMyTasks,
  DiscoveredMyTaskSections,
  DiscoveredSection,
  DiscoveryError,
  LocalConfigInitResult,
  MyTaskSectionsDiscoveryGateway,
  MyTasksDiscoveryGateway,
  StageFailureError,
} from "./local-initialization.ts";

const gid = z.string().regex(/^\d+$/, "must be a digit-only GID");
const gidMap = z.record(z.string().min(1), gid);
const workspace = z.object({ gid }).strict();
const project = z
  .object({
    gid: gid.optional(),
    sections: gidMap.optional(),
  })
  .strict();
const team = z.object({ gid }).strict();
const network = z
  .object({
    concurrency: z.number().int().positive().optional(),
    maxRetries: z.number().int().nonnegative().optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();
const myTasks = z
  .object({
    userTaskListGid: gid.optional(),
    sections: gidMap.optional(),
    customFields: gidMap.optional(),
  })
  .strict();
const assigneeDefault = z.union([z.literal("me"), gid]);

const sharedConfigSchema = z
  .object({
    workspace: workspace.optional(),
    project: project.optional(),
    team: team.optional(),
    network: network.optional(),
  })
  .strict();
const localConfigSchema = sharedConfigSchema.extend({
  myTasks: myTasks.optional(),
  defaultAssignee: assigneeDefault.optional(),
});
const globalConfigSchema = sharedConfigSchema;
const effectiveConfigSchema = localConfigSchema;

const builtInConfig = {
  network: {
    concurrency: 4,
    maxRetries: 3,
    requestTimeoutMs: 30_000,
  },
} satisfies Config;

export type Config = z.infer<typeof effectiveConfigSchema>;
export type ConfigLayer = "global" | "shared" | "local";
export type ConfigSourceLayer = "built-in" | ConfigLayer;

export type ConfigContext = Readonly<{
  cwd: string;
  home: string;
  environment: Readonly<Record<string, string | undefined>>;
  readonly fileOperations?: Readonly<{
    rename?: (oldPath: string, newPath: string) => Promise<void>;
    stageWrite?: (path: string, content: string) => Promise<void>;
  }>;
}>;

export type ConfigSource = Readonly<{
  layer: ConfigSourceLayer;
  path?: string;
}>;

export type ResolvedConfig = Readonly<{
  value: Config;
  sources: Readonly<Record<string, ConfigSource>>;
  paths: Readonly<{
    global: string;
    shared?: string;
    local?: string;
    gitRoot?: string;
  }>;
}>;

export type ConfigError = Readonly<{
  kind: "configuration";
  message: string;
}>;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const existsAsGitMarker = async (path: string): Promise<boolean> => {
  try {
    const marker = await stat(path);
    if (marker.isDirectory()) return true;
    if (!marker.isFile()) return false;
    const contents = await readFile(path, "utf8");
    const match = /^gitdir: (.+)\r?\n?$/.exec(contents);
    if (!match?.[1]) return false;
    const gitDirectory = await stat(resolve(dirname(path), match[1]));
    return gitDirectory.isDirectory();
  } catch {
    return false;
  }
};

const findGitRoot = async (cwd: string): Promise<string | undefined> => {
  let current = resolve(cwd);
  const filesystemRoot = parse(current).root;
  for (;;) {
    if (await existsAsGitMarker(join(current, ".git"))) return current;
    if (current === filesystemRoot) return undefined;
    current = dirname(current);
  }
};

const globalConfigPath = (context: ConfigContext): string =>
  join(
    context.environment.XDG_CONFIG_HOME ?? join(context.home, ".config"),
    "asana-cli",
    "config.json",
  );

const hasSecretShapedKey = (
  value: unknown,
  path: readonly string[] = [],
): string | undefined => {
  if (!isObject(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (/token/i.test(key) || /^pat$/i.test(key)) return childPath.join(".");
    const nested = hasSecretShapedKey(child, childPath);
    if (nested) return nested;
  }
  return undefined;
};

const issuePath = (issue: z.core.$ZodIssue): string =>
  issue.path.length === 0 ? "<root>" : issue.path.join(".");

const validationMessage = (
  path: string,
  value: unknown,
  schema: z.ZodType,
): Result<JsonObject, ConfigError> => {
  const secretPath = hasSecretShapedKey(value);
  if (secretPath) {
    return err({
      kind: "configuration",
      message: `${path}: ${secretPath} is forbidden; authentication secrets cannot be stored in config`,
    });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue
      ? `${issuePath(issue)}: ${issue.message}`
      : "invalid configuration";
    return err({
      kind: "configuration",
      message: `${path}: ${detail}`,
    });
  }
  return ok(parsed.data as JsonObject);
};

const readLayer = async (
  path: string,
  schema: z.ZodType,
): Promise<Result<JsonObject, ConfigError>> => {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return ok({});
    }
    return err({
      kind: "configuration",
      message: `${path}: could not be read`,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return err({
      kind: "configuration",
      message: `${path}: invalid JSON`,
    });
  }
  return validationMessage(path, value, schema);
};

const mergeObjects = (lower: JsonObject, higher: JsonObject): JsonObject => {
  const merged: JsonObject = { ...lower };
  for (const [key, value] of Object.entries(higher)) {
    const previous = merged[key];
    merged[key] =
      isObject(previous) && isObject(value)
        ? mergeObjects(previous, value)
        : value;
  }
  return merged;
};

const recordLeafSources = (
  value: JsonObject,
  source: ConfigSource,
  target: Record<string, ConfigSource>,
  prefix = "",
): void => {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isObject(child)) {
      recordLeafSources(child, source, target, path);
    } else {
      target[path] = source;
    }
  }
};

export const resolveConfig = async (
  context: ConfigContext,
): Promise<Result<ResolvedConfig, ConfigError>> => {
  const gitRoot = await findGitRoot(context.cwd);
  const paths = {
    global: globalConfigPath(context),
    ...(gitRoot
      ? {
          gitRoot,
          shared: join(gitRoot, ".asana-cli.json"),
          local: join(gitRoot, ".asana-cli.local.json"),
        }
      : {}),
  };
  const layers: ReadonlyArray<readonly [ConfigLayer, string, z.ZodType]> = [
    ["global", paths.global, globalConfigSchema],
    ...(paths.shared
      ? ([["shared", paths.shared, sharedConfigSchema]] as const)
      : []),
    ...(paths.local
      ? ([["local", paths.local, localConfigSchema]] as const)
      : []),
  ];
  let value: JsonObject = builtInConfig;
  const sources: Record<string, ConfigSource> = {};
  recordLeafSources(builtInConfig, { layer: "built-in" }, sources);
  for (const [layer, path, schema] of layers) {
    const read = await readLayer(path, schema);
    if (!read.ok) return read;
    value = mergeObjects(value, read.value);
    recordLeafSources(read.value, { layer, path }, sources);
  }
  const validated = validationMessage(
    "<merged config>",
    value,
    effectiveConfigSchema,
  );
  if (!validated.ok) return validated;
  return ok({
    value: validated.value as Config,
    sources,
    paths,
  });
};

const pathSegments = (key: string): Result<readonly string[], ConfigError> => {
  const segments = key.split(".");
  if (
    segments.length === 0 ||
    segments.some((segment) => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(segment))
  ) {
    return err({
      kind: "configuration",
      message: `${key}: invalid configuration key`,
    });
  }
  return ok(segments);
};

export const getConfigValue = (
  config: ResolvedConfig,
  key: string,
): Result<
  Readonly<{
    value: unknown;
    source?: ConfigSource;
    sources: Readonly<Record<string, ConfigSource>>;
  }>,
  ConfigError
> => {
  const segments = pathSegments(key);
  if (!segments.ok) return segments;
  let value: unknown = config.value;
  for (const segment of segments.value) {
    if (!isObject(value) || !(segment in value)) {
      return err({
        kind: "configuration",
        message: `${key}: configuration key is not set`,
      });
    }
    value = value[segment];
  }
  const sources = Object.fromEntries(
    Object.entries(config.sources).filter(
      ([sourceKey]) => sourceKey === key || sourceKey.startsWith(`${key}.`),
    ),
  );
  return ok({
    value,
    ...(config.sources[key] ? { source: config.sources[key] } : {}),
    sources,
  });
};

const schemaForLayer = (layer: ConfigLayer): z.ZodType =>
  layer === "shared"
    ? sharedConfigSchema
    : layer === "local"
      ? localConfigSchema
      : globalConfigSchema;

const stageWrite = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, {
    encoding: "utf8",
    flag: "wx",
  });
};

const cleanupTempFiles = async (paths: readonly string[]): Promise<void> => {
  for (const path of paths) {
    await rm(path, { force: true }).catch(() => undefined);
  }
};

const atomicWrite = async (
  path: string,
  value: JsonObject,
): Promise<Result<void, ConfigError>> => {
  const directory = dirname(path);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await stageWrite(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, path);
    return ok(undefined);
  } catch {
    await cleanupTempFiles([temporary]);
    return err({
      kind: "configuration",
      message: `${path}: could not be written`,
    });
  }
};

const targetPath = (
  resolvedConfig: ResolvedConfig,
  layer: ConfigLayer,
): Result<string, ConfigError> => {
  const path = resolvedConfig.paths[layer];
  if (!path) {
    return err({
      kind: "configuration",
      message: `${layer} configuration requires a git repository`,
    });
  }
  return ok(path);
};

const writeLayer = async (
  resolvedConfig: ResolvedConfig,
  layer: ConfigLayer,
  value: JsonObject,
): Promise<Result<void, ConfigError>> => {
  const path = targetPath(resolvedConfig, layer);
  if (!path.ok) return path;
  if (layer === "local") {
    const gitRoot = resolvedConfig.paths.gitRoot;
    if (!gitRoot || !(await localConfigIsIgnored(gitRoot))) {
      return err({
        kind: "configuration",
        message:
          "local configuration is not ignored by the repository .gitignore",
      });
    }
  }
  const validated = validationMessage(path.value, value, schemaForLayer(layer));
  if (!validated.ok) return validated;
  return atomicWrite(path.value, validated.value);
};

const setNestedValue = (
  config: JsonObject,
  segments: readonly string[],
  value: unknown,
): JsonObject => {
  const [head, ...tail] = segments;
  if (!head) return config;
  return {
    ...config,
    [head]:
      tail.length === 0
        ? value
        : setNestedValue(
            isObject(config[head]) ? config[head] : {},
            tail,
            value,
          ),
  };
};

const decodeConfigValueCandidates = (value: string): readonly unknown[] => {
  try {
    const decoded: unknown = JSON.parse(value);
    return decoded === value ? [value] : [value, decoded];
  } catch {
    return [value];
  }
};

const selectValidConfigMutation = (
  path: string,
  existing: JsonObject,
  segments: readonly string[],
  value: string,
  schema: z.ZodType,
): Result<JsonObject, ConfigError> => {
  let candidateError: ConfigError | undefined;
  for (const candidate of decodeConfigValueCandidates(value)) {
    const proposed = setNestedValue(existing, segments, candidate);
    const validated = validationMessage(path, proposed, schema);
    if (validated.ok) return validated;
    candidateError ??= validated.error;
  }
  return err(
    candidateError ?? {
      kind: "configuration",
      message: `${segments.join(".")}: invalid configuration value`,
    },
  );
};

const configWriteLayer = (
  segments: readonly string[],
  requestedLayer?: ConfigLayer,
): ConfigLayer =>
  requestedLayer ??
  (segments[0] === "myTasks" || segments[0] === "defaultAssignee"
    ? "local"
    : "shared");

export const setConfigValue = async (
  context: ConfigContext,
  key: string,
  value: string,
  requestedLayer?: ConfigLayer,
): Promise<Result<ConfigSource, ConfigError>> => {
  const segments = pathSegments(key);
  if (!segments.ok) return segments;
  const layer = configWriteLayer(segments.value, requestedLayer);
  const resolvedConfig = await resolveConfig(context);
  if (!resolvedConfig.ok) return resolvedConfig;
  const path = targetPath(resolvedConfig.value, layer);
  if (!path.ok) return path;
  const schema = schemaForLayer(layer);
  const existing = await readLayer(path.value, schema);
  if (!existing.ok) return existing;
  const updated = selectValidConfigMutation(
    path.value,
    existing.value,
    segments.value,
    value,
    schema,
  );
  if (!updated.ok) return updated;
  const written = await writeLayer(resolvedConfig.value, layer, updated.value);
  if (!written.ok) return written;
  return ok({ layer, path: path.value });
};

const configuredWorkspaceGid = (config: JsonObject): unknown =>
  isObject(config.workspace) ? config.workspace.gid : undefined;

const effectiveWorkspaceGid = (
  requested: string | undefined,
  shared: JsonObject,
  global: JsonObject,
): Result<string, ConfigError> => {
  const workspaceGid =
    requested ??
    configuredWorkspaceGid(shared) ??
    configuredWorkspaceGid(global);
  if (typeof workspaceGid === "string") return ok(workspaceGid);
  return err({
    kind: "configuration",
    message:
      "config init --shared requires --workspace or a workspace.gid in shared/global config",
  });
};

export const initializeSharedConfig = async (
  context: ConfigContext,
  workspaceGid?: string,
): Promise<Result<ConfigSource, ConfigError>> => {
  const resolvedConfig = await resolveConfig(context);
  if (!resolvedConfig.ok) return resolvedConfig;
  const path = targetPath(resolvedConfig.value, "shared");
  if (!path.ok) return path;
  const existing = await readLayer(path.value, sharedConfigSchema);
  if (!existing.ok) return existing;
  const global = await readLayer(
    resolvedConfig.value.paths.global,
    globalConfigSchema,
  );
  if (!global.ok) return global;
  const effectiveWorkspace = effectiveWorkspaceGid(
    workspaceGid,
    existing.value,
    global.value,
  );
  if (!effectiveWorkspace.ok) return effectiveWorkspace;
  const updated = setNestedValue(
    existing.value,
    ["workspace", "gid"],
    effectiveWorkspace.value,
  );
  const written = await writeLayer(resolvedConfig.value, "shared", updated);
  if (!written.ok) return written;
  return ok({ layer: "shared", path: path.value });
};

export const initializeLocalConfig = (
  context: ConfigContext,
  token: string,
  discovery: MyTasksDiscoveryGateway,
  options: { writeGitignore?: boolean },
) =>
  initializeLocalConfigWorkflow(context, token, discovery, options, {
    resolveConfig,
    readLocalConfig: (path) => readLayer(path, localConfigSchema),
    validateLocalConfig: (path, value) =>
      validationMessage(path, value, localConfigSchema),
    targetLocalPath: (resolvedConfig) => targetPath(resolvedConfig, "local"),
    stageWrite,
    cleanupTempFiles,
  });

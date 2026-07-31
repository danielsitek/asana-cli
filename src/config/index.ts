import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import { z } from "zod";

import { err, ok, type Result } from "../shared/result.ts";

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
    return marker.isDirectory() || marker.isFile();
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

const localFileIsIgnored = async (gitRoot: string): Promise<boolean> => {
  try {
    const contents = await readFile(join(gitRoot, ".gitignore"), "utf8");
    let ignored = false;
    for (const rawLine of contents.split(/\r?\n/)) {
      let rule = rawLine.trim();
      if (!rule || rule.startsWith("#")) continue;
      let negated = false;
      if (rule.startsWith("\\!") || rule.startsWith("\\#")) {
        rule = rule.slice(1);
      } else if (rule.startsWith("!")) {
        negated = true;
        rule = rule.slice(1);
      }
      if (!rule || rule.endsWith("/")) continue;
      if (rule.startsWith("/")) rule = rule.slice(1);
      const target = ".asana-cli.local.json";
      const expression = globExpression(rule);
      const matches = new RegExp(`^${expression}$`).test(target);
      if (matches) ignored = !negated;
    }
    return ignored;
  } catch {
    return false;
  }
};

const globExpression = (pattern: string): string => {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else if (character) {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return expression;
};

const atomicWrite = async (
  path: string,
  value: JsonObject,
): Promise<Result<void, ConfigError>> => {
  const directory = dirname(path);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, path);
    return ok(undefined);
  } catch {
    try {
      await rm(temporary, { force: true });
    } catch {
      // Preserve the original write failure.
    }
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
    if (!gitRoot || !(await localFileIsIgnored(gitRoot))) {
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

export const setConfigValue = async (
  context: ConfigContext,
  key: string,
  value: string,
  requestedLayer?: ConfigLayer,
): Promise<Result<ConfigSource, ConfigError>> => {
  const segments = pathSegments(key);
  if (!segments.ok) return segments;
  const layer =
    requestedLayer ?? (segments.value[0] === "myTasks" ? "local" : "shared");
  const resolvedConfig = await resolveConfig(context);
  if (!resolvedConfig.ok) return resolvedConfig;
  const path = targetPath(resolvedConfig.value, layer);
  if (!path.ok) return path;
  const existing = await readLayer(path.value, schemaForLayer(layer));
  if (!existing.ok) return existing;
  const candidates: unknown[] = [value];
  try {
    const jsonValue: unknown = JSON.parse(value);
    if (jsonValue !== value) candidates.push(jsonValue);
  } catch {
    // Plain strings such as GIDs are valid candidates themselves.
  }
  let updated: JsonObject | undefined;
  let candidateError: ConfigError | undefined;
  for (const candidate of candidates) {
    const proposed = setNestedValue(existing.value, segments.value, candidate);
    const validated = validationMessage(
      path.value,
      proposed,
      schemaForLayer(layer),
    );
    if (validated.ok) {
      updated = validated.value;
      break;
    }
    candidateError ??= validated.error;
  }
  if (!updated) {
    return err(
      candidateError ?? {
        kind: "configuration",
        message: `${key}: invalid configuration value`,
      },
    );
  }
  const written = await writeLayer(resolvedConfig.value, layer, updated);
  if (!written.ok) return written;
  return ok({ layer, path: path.value });
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
  const sharedWorkspace = isObject(existing.value.workspace)
    ? existing.value.workspace.gid
    : undefined;
  const globalWorkspace = isObject(global.value.workspace)
    ? global.value.workspace.gid
    : undefined;
  const effectiveWorkspace = workspaceGid ?? sharedWorkspace ?? globalWorkspace;
  if (typeof effectiveWorkspace !== "string") {
    return err({
      kind: "configuration",
      message:
        "config init --shared requires --workspace or a workspace.gid in shared/global config",
    });
  }
  const updated = setNestedValue(
    existing.value,
    ["workspace", "gid"],
    effectiveWorkspace,
  );
  const written = await writeLayer(resolvedConfig.value, "shared", updated);
  if (!written.ok) return written;
  return ok({ layer: "shared", path: path.value });
};

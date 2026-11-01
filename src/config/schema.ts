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
const assigneeDefault = z.union([z.literal("me"), gid]);

export const sharedConfigSchema = z
  .object({
    workspace: workspace.optional(),
    project: project.optional(),
    team: team.optional(),
    network: network.optional(),
  })
  .strict();
export const localConfigSchema = sharedConfigSchema.extend({
  myTasks: myTasks.optional(),
  defaultAssignee: assigneeDefault.optional(),
});
export const globalConfigSchema = sharedConfigSchema;
export const effectiveConfigSchema = localConfigSchema;

export type Config = z.infer<typeof effectiveConfigSchema>;
export type ConfigError = Readonly<{
  kind: "configuration";
  message: string;
}>;
export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

export const validationMessage = (
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

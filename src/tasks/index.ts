import { z } from "zod";

import { err, ok, type Result } from "../shared/result.ts";

export type Task = Readonly<{
  gid: string;
  name: string;
  notes: string;
  completed: boolean;
  due_on: string | null;
  assignee: Readonly<{
    gid: string;
    name: string;
  }> | null;
  [key: string]: unknown;
}>;

export type TaskReadError = Readonly<{
  kind:
    | "authentication"
    | "api"
    | "not_found"
    | "rate_limit"
    | "network"
    | "invalid_response";
  message: string;
  status?: number;
}>;

export interface TaskGateway {
  getTask(
    token: string,
    taskId: string,
    fields: readonly string[],
  ): Promise<Result<Task, TaskReadError>>;
}

export const DEFAULT_FIELDS = [
  "gid",
  "name",
  "notes",
  "completed",
  "due_on",
  "assignee.gid",
  "assignee.name",
] as const;

export const parseTaskId = (input: string): Result<string, string> => {
  if (/^\d+$/.test(input)) {
    return ok(input);
  }
  const match = input.match(
    /^https:\/\/app\.asana\.com\/0\/(\d+)\/(\d+)(?:\/f)?$/,
  );
  if (match && typeof match[2] === "string") {
    return ok(match[2]);
  }
  return err("Invalid task identifier");
};

export const validateFieldList = (
  input: string,
): Result<readonly string[], string> => {
  if (input.trim() === "") {
    return err("Fields list cannot be empty");
  }
  const segments = input.split(",");
  const processed: string[] = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed === "") {
      return err("Fields list cannot contain empty segments");
    }
    processed.push(trimmed);
  }
  const unique = Array.from(new Set(processed));
  return ok(unique);
};

export function buildTaskSchema(requestedFields: readonly string[]) {
  const topLevelFields = new Set(
    requestedFields.map((f) => f.split(".")[0] as string),
  );

  const shape: Record<string, z.ZodTypeAny> = {};

  // For gid
  if (topLevelFields.has("gid")) {
    shape.gid = z.string();
  } else {
    shape.gid = z.string().optional();
  }

  // For name
  if (topLevelFields.has("name")) {
    shape.name = z.string();
  } else {
    shape.name = z.string().optional();
  }

  // For notes
  if (topLevelFields.has("notes")) {
    shape.notes = z.string();
  } else {
    shape.notes = z.string().optional();
  }

  // For completed
  if (topLevelFields.has("completed")) {
    shape.completed = z.boolean();
  } else {
    shape.completed = z.boolean().optional();
  }

  // For due_on
  if (topLevelFields.has("due_on")) {
    shape.due_on = z.string().nullable();
  } else {
    shape.due_on = z.string().nullable().optional();
  }

  // For assignee
  const assigneeSubfields = requestedFields
    .filter((f) => f.startsWith("assignee."))
    .map((f) => f.slice("assignee.".length));
  const assigneeIsRequested = topLevelFields.has("assignee");

  const assigneeShape: Record<string, z.ZodTypeAny> = {};
  if (assigneeSubfields.includes("gid")) {
    assigneeShape.gid = z.string();
  } else {
    assigneeShape.gid = z.string().optional();
  }

  if (assigneeSubfields.includes("name")) {
    assigneeShape.name = z.string();
  } else {
    assigneeShape.name = z.string().optional();
  }

  const assigneeSchema = z.object(assigneeShape).passthrough().nullable();
  if (assigneeIsRequested) {
    shape.assignee = assigneeSchema;
  } else {
    shape.assignee = assigneeSchema.optional();
  }

  // For any other arbitrary requested fields that are NOT known top-level fields:
  const knownTopLevel = new Set([
    "gid",
    "name",
    "notes",
    "completed",
    "due_on",
    "assignee",
  ]);
  for (const field of topLevelFields) {
    if (!knownTopLevel.has(field)) {
      // This is an arbitrary requested field. It MUST be present.
      shape[field] = z.unknown();
    }
  }

  return z.object(shape).passthrough();
}

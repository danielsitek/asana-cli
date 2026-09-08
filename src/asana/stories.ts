import { z } from "zod";

import type { Comment } from "../comments/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type { TaskReadError } from "../tasks/index.ts";
import { resolvePath } from "../utils/resolve-path.ts";
import type { HttpRequestOptions } from "./http-transport.ts";
import {
  hasOwn,
  isDigitOnlyGid,
  isNullableNamedResource,
  isRecord,
} from "./response-validation.ts";

export type TaskStoriesOptions = Readonly<{
  fields: readonly string[];
  limit: number;
  offset?: string;
}>;

const knownCommentFieldsAreValid = (
  value: Record<string, unknown>,
  requestedCreatedByFields: ReadonlySet<string>,
): boolean =>
  (!hasOwn(value, "gid") || isDigitOnlyGid(value.gid)) &&
  (!hasOwn(value, "created_at") || typeof value.created_at === "string") &&
  (!hasOwn(value, "text") || typeof value.text === "string") &&
  (!hasOwn(value, "resource_subtype") ||
    typeof value.resource_subtype === "string") &&
  (!hasOwn(value, "created_by") ||
    isNullableNamedResource(value.created_by, requestedCreatedByFields));

const requestedCommentFieldIsPresent = (
  value: Record<string, unknown>,
  field: string,
): boolean => {
  const path = field.split(".");
  if (path[0] === "created_by" && value.created_by === null) return true;
  return resolvePath(value, path).found;
};

export const buildCommentSchema = (
  fields: readonly string[],
): z.ZodType<Comment> => {
  const requestedCreatedByFields = new Set(
    fields
      .filter(
        (field) => field === "created_by.gid" || field === "created_by.name",
      )
      .map((field) => field.slice("created_by.".length)),
  );
  // The stories endpoint returns every story type, not just comments, and
  // non-comment system stories routinely omit fields like "text". Only
  // comment_added stories are retained, so only they require every field.
  return z.custom<Comment>(
    (value) =>
      isRecord(value) &&
      knownCommentFieldsAreValid(value, requestedCreatedByFields) &&
      (value.resource_subtype !== "comment_added" ||
        fields.every((field) => requestedCommentFieldIsPresent(value, field))),
  );
};

const buildStoriesPageSchema = (fields: readonly string[]) =>
  z.object({
    data: z.array(buildCommentSchema(fields)),
    next_page: z
      .object({ offset: z.string() })
      .passthrough()
      .nullable()
      .optional(),
  });

type PreparedStoryRequest = Readonly<{
  path: string;
  options: HttpRequestOptions;
  schema: ReturnType<typeof buildStoriesPageSchema>;
}>;

export const prepareTaskStoriesRequest = (
  taskId: string,
  options: TaskStoriesOptions,
): Result<PreparedStoryRequest, TaskReadError> => {
  if (!isDigitOnlyGid(taskId)) {
    return err({
      kind: "invalid_response",
      message: "Task GID is not digit-only",
    });
  }
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  ) {
    return err({
      kind: "invalid_response",
      message: "Story page limit must be between 1 and 100",
    });
  }
  return ok({
    path: `tasks/${taskId}/stories`,
    options: {
      method: "GET",
      searchParams: {
        limit: String(options.limit),
        opt_fields: options.fields.join(","),
        ...(options.offset === undefined ? {} : { offset: options.offset }),
      },
    },
    schema: buildStoriesPageSchema(options.fields),
  });
};

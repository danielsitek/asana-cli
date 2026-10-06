import { err, ok, type Result } from "../shared/result.ts";
import { parseTaskId, validateFieldList } from "../tasks/index.ts";
import { projectFields } from "../utils/project-fields.ts";

export type Comment = Readonly<{
  gid?: string;
  created_at?: string;
  text?: string;
  created_by?: Readonly<{
    gid?: string;
    name?: string;
    [key: string]: unknown;
  }> | null;
  resource_subtype?: string;
  [key: string]: unknown;
}>;

export type CommentPreparationError = Readonly<{
  kind: "invalid_usage";
  message: string;
}>;

export const DEFAULT_COMMENT_FIELDS = [
  "gid",
  "created_at",
  "text",
  "created_by.gid",
  "created_by.name",
] as const;

const resolvedCommentFields = (
  input: string | undefined,
): Result<readonly string[], CommentPreparationError> => {
  if (input === undefined) return ok(DEFAULT_COMMENT_FIELDS);
  const validated = validateFieldList(input);
  return validated.ok
    ? validated
    : err({ kind: "invalid_usage", message: validated.error });
};

export const prepareCommentTarget = (
  taskIdInput: string,
  fields: string | undefined,
): Result<
  Readonly<{ taskId: string; outputFields: readonly string[] }>,
  CommentPreparationError
> => {
  const taskId = parseTaskId(taskIdInput);
  if (!taskId.ok) return err({ kind: "invalid_usage", message: taskId.error });

  const outputFields = resolvedCommentFields(fields);
  if (!outputFields.ok) return outputFields;

  return ok({ taskId: taskId.value, outputFields: outputFields.value });
};

export const projectCommentFields = (
  comment: Comment,
  fields: readonly string[],
): Comment => {
  const availableFields = fields.filter(
    (field) => projectFields(comment, [field]).found,
  );
  const projected = projectFields(comment, availableFields);
  return projected.found ? projected.value : {};
};

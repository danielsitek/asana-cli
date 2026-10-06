import { err, ok, type Result } from "../shared/result.ts";
import type { TaskReadError } from "../tasks/index.ts";
import {
  prepareCommentTarget,
  projectCommentFields,
  type Comment,
  type CommentPreparationError,
} from "./shared.ts";

export type PreparedTaskCommentCreate = Readonly<{
  taskId: string;
  outputFields: readonly string[];
  text?: string;
  file?: string;
}>;

export interface TaskCommentCreationGateway {
  createTaskComment(
    token: string,
    taskId: string,
    text: string,
    fields: readonly string[],
  ): Promise<Result<Comment, TaskReadError>>;
}

export type TaskCommentCreateError =
  | Readonly<{ kind: "invalid_usage"; message: string }>
  | TaskReadError;

export const prepareTaskCommentCreate = (
  taskIdInput: string,
  options: Readonly<{
    fields?: string;
    text?: string;
    file?: string;
  }>,
): Result<PreparedTaskCommentCreate, CommentPreparationError> => {
  const target = prepareCommentTarget(taskIdInput, options.fields);
  if (!target.ok) return target;
  const { taskId, outputFields } = target.value;

  const hasText = options.text !== undefined;
  const hasFile = options.file !== undefined;
  if (hasText && hasFile) {
    return err({
      kind: "invalid_usage",
      message: "Positional text and --file are mutually exclusive",
    });
  }
  if (!hasText && !hasFile) {
    return err({
      kind: "invalid_usage",
      message: "Either positional text or --file is required",
    });
  }
  if (options.text === "") {
    return err({
      kind: "invalid_usage",
      message: "Comment text cannot be empty",
    });
  }
  if (options.file === "") {
    return err({ kind: "invalid_usage", message: "--file cannot be empty" });
  }

  return ok({
    taskId,
    outputFields,
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.file === undefined ? {} : { file: options.file }),
  });
};

export const executeTaskCommentCreate = async (
  token: string,
  prepared: PreparedTaskCommentCreate,
  dependencies: Readonly<{
    writer: TaskCommentCreationGateway;
    readFile: (path: string) => Promise<string>;
    readStdin: () => Promise<string>;
  }>,
): Promise<Result<Comment, TaskCommentCreateError>> => {
  let text = prepared.text;
  if (prepared.file !== undefined) {
    try {
      text =
        prepared.file === "-"
          ? await dependencies.readStdin()
          : await dependencies.readFile(prepared.file);
    } catch {
      return err({
        kind: "invalid_usage",
        message:
          prepared.file === "-"
            ? "Unable to read comment from stdin"
            : "Unable to read comment file",
      });
    }
  }

  if (text === undefined || text === "") {
    return err({
      kind: "invalid_usage",
      message: "Comment text cannot be empty",
    });
  }

  const created = await dependencies.writer.createTaskComment(
    token,
    prepared.taskId,
    text,
    prepared.outputFields,
  );
  return created.ok
    ? ok(projectCommentFields(created.value, prepared.outputFields))
    : created;
};

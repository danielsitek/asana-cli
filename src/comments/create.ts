import { err, ok, type Result } from "../shared/result.ts";
import type { TaskReadError, TaskWriteError } from "../tasks/index.ts";
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
  replyTo?: string;
}>;

export type CommentReplyTarget = Readonly<{
  resource_subtype: string;
  target: Readonly<{ gid: string }> | null;
  comment_gid: string | null;
  anchor_gid: string | null;
}>;

export interface TaskCommentCreationGateway {
  getCommentReplyTarget(
    token: string,
    storyId: string,
  ): Promise<Result<CommentReplyTarget, TaskReadError>>;

  createTaskComment(
    token: string,
    taskId: string,
    text: string,
    fields: readonly string[],
    parentCommentGid?: string,
  ): Promise<Result<Comment, TaskWriteError>>;
}

export type TaskCommentCreateError =
  | Readonly<{ kind: "invalid_usage"; message: string }>
  | TaskWriteError;

export const prepareTaskCommentCreate = (
  taskIdInput: string,
  options: Readonly<{
    fields?: string;
    text?: string;
    file?: string;
    replyTo?: string;
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
  if (options.replyTo !== undefined && !/^\d+$/.test(options.replyTo)) {
    return err({
      kind: "invalid_usage",
      message: "--reply-to requires a numeric story GID",
    });
  }

  return ok({
    taskId,
    outputFields,
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.file === undefined ? {} : { file: options.file }),
    ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
  });
};

const resolveParentComment = async (
  writer: TaskCommentCreationGateway,
  token: string,
  taskId: string,
  storyId: string,
): Promise<Result<string, TaskCommentCreateError>> => {
  const story = await writer.getCommentReplyTarget(token, storyId);
  const invalidTarget = {
    kind: "invalid_usage",
    message: "--reply-to must identify a comment on this task",
  } as const;
  if (!story.ok) {
    return story.error.kind === "not_found" ? err(invalidTarget) : story;
  }
  const { resource_subtype, target, comment_gid, anchor_gid } = story.value;
  if (resource_subtype !== "comment_added" || target?.gid !== taskId) {
    return err(invalidTarget);
  }
  if (comment_gid === null) {
    return err({
      kind: "invalid_usage",
      message: "This comment does not have an Asana comment GID for replies",
    });
  }
  if (anchor_gid !== taskId) {
    return err({
      kind: "invalid_usage",
      message: "--reply-to requires a top-level comment",
    });
  }
  return ok(comment_gid);
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

  let parentCommentGid: string | undefined;
  if (prepared.replyTo !== undefined) {
    const parent = await resolveParentComment(
      dependencies.writer,
      token,
      prepared.taskId,
      prepared.replyTo,
    );
    if (!parent.ok) return parent;
    parentCommentGid = parent.value;
  }

  const created = await dependencies.writer.createTaskComment(
    token,
    prepared.taskId,
    text,
    prepared.outputFields,
    parentCommentGid,
  );
  return created.ok
    ? ok(projectCommentFields(created.value, prepared.outputFields))
    : created;
};

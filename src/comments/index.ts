import { err, ok, type Result } from "../shared/result.ts";
import {
  parseTaskId,
  validateFieldList,
  type TaskReadError,
} from "../tasks/index.ts";
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

export type TaskCommentListMeta = Readonly<{
  scanned: number;
  returned: number;
  scan_truncated: boolean;
  next_offset?: string;
}>;

export type PreparedTaskCommentsRead = Readonly<{
  taskId: string;
  outputFields: readonly string[];
  requestFields: readonly string[];
  scanCap: number;
  resultCap?: number;
  offset?: string;
}>;

export type PreparedTaskCommentCreate = Readonly<{
  taskId: string;
  outputFields: readonly string[];
  text?: string;
  file?: string;
}>;

export interface TaskStoryGateway {
  getTaskStories(
    token: string,
    taskId: string,
    options: Readonly<{
      fields: readonly string[];
      limit: number;
      offset?: string;
    }>,
  ): Promise<
    Result<
      Readonly<{
        stories: readonly Comment[];
        nextOffset?: string;
      }>,
      TaskReadError
    >
  >;
}

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

export const DEFAULT_COMMENT_FIELDS = [
  "gid",
  "created_at",
  "text",
  "created_by.gid",
  "created_by.name",
] as const;

const DEFAULT_SCAN_CAP = 100;
const DEFAULT_RESULT_CAP = 20;
const RESOURCE_SUBTYPE_FIELD = "resource_subtype";

const parsePositiveSafeInteger = (
  input: string,
  flag: string,
): Result<number, Readonly<{ kind: "invalid_usage"; message: string }>> => {
  if (!/^\d+$/.test(input)) {
    return err({
      kind: "invalid_usage",
      message: `${flag} must be a positive safe integer`,
    });
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return err({
      kind: "invalid_usage",
      message: `${flag} must be a positive safe integer`,
    });
  }
  return ok(value);
};

const resolvedCommentFields = (
  input: string | undefined,
): Result<
  readonly string[],
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  if (input === undefined) return ok(DEFAULT_COMMENT_FIELDS);
  const validated = validateFieldList(input);
  return validated.ok
    ? validated
    : err({ kind: "invalid_usage", message: validated.error });
};

const withInternalFields = (fields: readonly string[]): readonly string[] =>
  fields.includes(RESOURCE_SUBTYPE_FIELD)
    ? fields
    : [...fields, RESOURCE_SUBTYPE_FIELD];

const projectCommentFields = (
  comment: Comment,
  fields: readonly string[],
): Comment => {
  const availableFields = fields.filter(
    (field) => projectFields(comment, [field]).found,
  );
  const projected = projectFields(comment, availableFields);
  return projected.found ? projected.value : {};
};

export const prepareTaskCommentsRead = (
  taskIdInput: string,
  options: Readonly<{
    fields?: string;
    max?: string;
    offset?: string;
    all?: boolean;
  }>,
): Result<
  PreparedTaskCommentsRead,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  const taskId = parseTaskId(taskIdInput);
  if (!taskId.ok) return err({ kind: "invalid_usage", message: taskId.error });

  const outputFields = resolvedCommentFields(options.fields);
  if (!outputFields.ok) return outputFields;

  if (options.offset === "") {
    return err({ kind: "invalid_usage", message: "--offset cannot be empty" });
  }

  if (options.all && options.max === undefined) {
    return err({
      kind: "invalid_usage",
      message: "--all requires --max",
    });
  }

  const scanCap =
    options.max === undefined
      ? ok(DEFAULT_SCAN_CAP)
      : parsePositiveSafeInteger(options.max, "--max");
  if (!scanCap.ok) return scanCap;

  return ok({
    taskId: taskId.value,
    outputFields: outputFields.value,
    requestFields: withInternalFields(outputFields.value),
    scanCap: scanCap.value,
    ...(options.offset === undefined ? {} : { offset: options.offset }),
    ...(options.all ? {} : { resultCap: DEFAULT_RESULT_CAP }),
  });
};

export const executeTaskCommentsRead = async (
  token: string,
  prepared: PreparedTaskCommentsRead,
  dependencies: Readonly<{ reader: TaskStoryGateway }>,
): Promise<
  Result<
    Readonly<{
      comments: readonly Comment[];
      meta: TaskCommentListMeta;
    }>,
    TaskReadError
  >
> => {
  const comments: Comment[] = [];
  let scanned = 0;
  let offset = prepared.offset;
  const requestedOffsets = new Set<string>();

  while (scanned < prepared.scanCap) {
    if (offset !== undefined) requestedOffsets.add(offset);
    const remaining = prepared.scanCap - scanned;
    const page = await dependencies.reader.getTaskStories(
      token,
      prepared.taskId,
      {
        fields: prepared.requestFields,
        limit: Math.min(100, remaining),
        ...(offset === undefined ? {} : { offset }),
      },
    );
    if (!page.ok) return page;

    const { stories, nextOffset } = page.value;
    if (
      nextOffset !== undefined &&
      (stories.length === 0 || requestedOffsets.has(nextOffset))
    ) {
      return err({
        kind: "invalid_response",
        message: "Story pagination did not advance",
      });
    }
    const storiesWithinBudget = stories.slice(0, remaining);
    const pageExceedsBudget = stories.length > storiesWithinBudget.length;
    for (let index = 0; index < storiesWithinBudget.length; index += 1) {
      const story = storiesWithinBudget[index]!;
      scanned += 1;
      if (story.resource_subtype === "comment_added") {
        comments.push(projectCommentFields(story, prepared.outputFields));
        if (
          prepared.resultCap !== undefined &&
          comments.length >= prepared.resultCap
        ) {
          const stoppedMidPage = index < stories.length - 1;
          const scanCapReached = scanned >= prepared.scanCap;
          const scanTruncated =
            scanCapReached && (stoppedMidPage || nextOffset !== undefined);
          return ok({
            comments,
            meta: {
              scanned,
              returned: comments.length,
              scan_truncated: scanTruncated,
              ...(!stoppedMidPage && nextOffset !== undefined
                ? { next_offset: nextOffset }
                : {}),
            },
          });
        }
      }
    }

    if (scanned >= prepared.scanCap) {
      return ok({
        comments,
        meta: {
          scanned,
          returned: comments.length,
          scan_truncated: pageExceedsBudget || nextOffset !== undefined,
          ...(pageExceedsBudget || nextOffset === undefined
            ? {}
            : { next_offset: nextOffset }),
        },
      });
    }

    if (nextOffset === undefined) {
      return ok({
        comments,
        meta: {
          scanned,
          returned: comments.length,
          scan_truncated: false,
        },
      });
    }
    offset = nextOffset;
  }

  return ok({
    comments,
    meta: {
      scanned,
      returned: comments.length,
      scan_truncated: false,
    },
  });
};

export const prepareTaskCommentCreate = (
  taskIdInput: string,
  options: Readonly<{
    fields?: string;
    text?: string;
    file?: string;
  }>,
): Result<
  PreparedTaskCommentCreate,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  const taskId = parseTaskId(taskIdInput);
  if (!taskId.ok) return err({ kind: "invalid_usage", message: taskId.error });

  const outputFields = resolvedCommentFields(options.fields);
  if (!outputFields.ok) return outputFields;

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
    return err({
      kind: "invalid_usage",
      message: "--file cannot be empty",
    });
  }

  return ok({
    taskId: taskId.value,
    outputFields: outputFields.value,
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

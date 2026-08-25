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

type TaskCommentsReadMode =
  | Readonly<{ kind: "capped"; resultCap: number; offset?: string }>
  | Readonly<{ kind: "all"; offset?: string }>
  | Readonly<{ kind: "latest"; count: number }>;

export type PreparedTaskCommentsRead = Readonly<{
  taskId: string;
  outputFields: readonly string[];
  requestFields: readonly string[];
  scanCap: number;
  mode: TaskCommentsReadMode;
}>;

export type PreparedTaskCommentCreate = Readonly<{
  taskId: string;
  outputFields: readonly string[];
  text?: string;
  file?: string;
}>;

export interface TaskStoryGateway {
  /** Returns each page in Asana's chronological story order (oldest first). */
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

export type TaskCommentsReadError =
  | TaskReadError
  | Readonly<{ kind: "scan_limit"; message: string }>;

type TaskCommentsReadValue = Readonly<{
  comments: readonly Comment[];
  meta: TaskCommentListMeta;
}>;

type TaskCommentsReadResult = Result<
  TaskCommentsReadValue,
  TaskCommentsReadError
>;

type CommentScanState = {
  comments: Comment[];
  scanned: number;
};

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

type CommentPreparationError = Readonly<{
  kind: "invalid_usage";
  message: string;
}>;

const prepareCommentTarget = (
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
    latest?: string;
  }>,
): Result<PreparedTaskCommentsRead, CommentPreparationError> => {
  const target = prepareCommentTarget(taskIdInput, options.fields);
  if (!target.ok) return target;
  const { taskId, outputFields } = target.value;

  if (options.offset === "") {
    return err({ kind: "invalid_usage", message: "--offset cannot be empty" });
  }

  let latestValue: number | undefined;
  if (options.latest !== undefined) {
    if (options.all) {
      return err({
        kind: "invalid_usage",
        message: "--latest and --all are mutually exclusive",
      });
    }
    if (options.offset !== undefined) {
      return err({
        kind: "invalid_usage",
        message: "--latest and --offset are mutually exclusive",
      });
    }
    if (options.max === undefined) {
      return err({
        kind: "invalid_usage",
        message: "--latest requires --max",
      });
    }
    const parsedLatest = parsePositiveSafeInteger(options.latest, "--latest");
    if (!parsedLatest.ok) return parsedLatest;
    latestValue = parsedLatest.value;
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
    taskId,
    outputFields,
    requestFields: withInternalFields(outputFields),
    scanCap: scanCap.value,
    mode:
      latestValue !== undefined
        ? { kind: "latest", count: latestValue }
        : options.all
          ? {
              kind: "all",
              ...(options.offset === undefined
                ? {}
                : { offset: options.offset }),
            }
          : {
              kind: "capped",
              resultCap: DEFAULT_RESULT_CAP,
              ...(options.offset === undefined
                ? {}
                : { offset: options.offset }),
            },
  });
};

const completedCommentsRead = (
  state: CommentScanState,
  scanTruncated: boolean,
  nextOffset?: string,
): TaskCommentsReadValue => ({
  comments: state.comments,
  meta: {
    scanned: state.scanned,
    returned: state.comments.length,
    scan_truncated: scanTruncated,
    ...(nextOffset === undefined ? {} : { next_offset: nextOffset }),
  },
});

const completedLatestCommentsRead = (
  state: CommentScanState,
): TaskCommentsReadValue => ({
  comments: [...state.comments].reverse(),
  meta: {
    scanned: state.scanned,
    returned: state.comments.length,
    scan_truncated: false,
  },
});

const initialCommentsOffset = (
  mode: TaskCommentsReadMode,
): string | undefined => (mode.kind === "latest" ? undefined : mode.offset);

const completedSourceRead = (
  prepared: PreparedTaskCommentsRead,
  state: CommentScanState,
): TaskCommentsReadResult =>
  ok(
    prepared.mode.kind === "latest"
      ? completedLatestCommentsRead(state)
      : completedCommentsRead(state, false),
  );

const paginationError = (
  stories: readonly Comment[],
  nextOffset: string | undefined,
  requestedOffsets: ReadonlySet<string>,
): TaskCommentsReadResult | undefined => {
  if (
    nextOffset === undefined ||
    (stories.length > 0 && !requestedOffsets.has(nextOffset))
  ) {
    return undefined;
  }
  return err({
    kind: "invalid_response",
    message: "Story pagination did not advance",
  });
};

const collectLatestComments = (
  stories: readonly Comment[],
  outputFields: readonly string[],
  latestCap: number,
  state: CommentScanState,
): void => {
  for (const story of stories) {
    state.scanned += 1;
    if (story.resource_subtype !== "comment_added") continue;

    state.comments.push(projectCommentFields(story, outputFields));
    if (state.comments.length > latestCap) state.comments.shift();
  }
};

const collectStandardComments = (
  stories: readonly Comment[],
  pageStoryCount: number,
  nextOffset: string | undefined,
  prepared: PreparedTaskCommentsRead,
  state: CommentScanState,
): TaskCommentsReadResult | undefined => {
  const resultCap =
    prepared.mode.kind === "capped" ? prepared.mode.resultCap : undefined;

  for (const [index, story] of stories.entries()) {
    state.scanned += 1;
    if (story.resource_subtype !== "comment_added") continue;

    state.comments.push(projectCommentFields(story, prepared.outputFields));
    if (resultCap === undefined || state.comments.length < resultCap) continue;

    const stoppedMidPage = index < pageStoryCount - 1;
    const scanTruncated =
      state.scanned >= prepared.scanCap &&
      (stoppedMidPage || nextOffset !== undefined);
    return ok(
      completedCommentsRead(
        state,
        scanTruncated,
        stoppedMidPage ? undefined : nextOffset,
      ),
    );
  }
  return undefined;
};

const collectPageComments = (
  stories: readonly Comment[],
  pageStoryCount: number,
  nextOffset: string | undefined,
  prepared: PreparedTaskCommentsRead,
  state: CommentScanState,
): TaskCommentsReadResult | undefined => {
  if (prepared.mode.kind !== "latest") {
    return collectStandardComments(
      stories,
      pageStoryCount,
      nextOffset,
      prepared,
      state,
    );
  }
  collectLatestComments(
    stories,
    prepared.outputFields,
    prepared.mode.count,
    state,
  );
  return undefined;
};

const finishAtScanCap = (
  prepared: PreparedTaskCommentsRead,
  state: CommentScanState,
  pageExceedsBudget: boolean,
  nextOffset: string | undefined,
): TaskCommentsReadResult => {
  const truncated = pageExceedsBudget || nextOffset !== undefined;
  if (prepared.mode.kind !== "latest") {
    return ok(
      completedCommentsRead(
        state,
        truncated,
        pageExceedsBudget ? undefined : nextOffset,
      ),
    );
  }
  if (!truncated) return ok(completedLatestCommentsRead(state));

  return err({
    kind: "scan_limit",
    message: `Reached --max=${prepared.scanCap} before confirming the newest ${prepared.mode.count} comment(s); rerun with a higher --max`,
  });
};

const finishAfterPage = (
  prepared: PreparedTaskCommentsRead,
  state: CommentScanState,
  pageExceedsBudget: boolean,
  nextOffset: string | undefined,
): TaskCommentsReadResult | undefined => {
  if (state.scanned >= prepared.scanCap) {
    return finishAtScanCap(prepared, state, pageExceedsBudget, nextOffset);
  }
  if (nextOffset !== undefined) return undefined;
  return completedSourceRead(prepared, state);
};

export const executeTaskCommentsRead = async (
  token: string,
  prepared: PreparedTaskCommentsRead,
  dependencies: Readonly<{ reader: TaskStoryGateway }>,
): Promise<TaskCommentsReadResult> => {
  const state: CommentScanState = { comments: [], scanned: 0 };
  let offset = initialCommentsOffset(prepared.mode);
  const requestedOffsets = new Set<string>();

  while (state.scanned < prepared.scanCap) {
    if (offset !== undefined) requestedOffsets.add(offset);
    const remaining = prepared.scanCap - state.scanned;
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
    const invalidPagination = paginationError(
      stories,
      nextOffset,
      requestedOffsets,
    );
    if (invalidPagination !== undefined) return invalidPagination;

    const storiesWithinBudget = stories.slice(0, remaining);
    const pageExceedsBudget = stories.length > storiesWithinBudget.length;

    const cappedResult = collectPageComments(
      storiesWithinBudget,
      stories.length,
      nextOffset,
      prepared,
      state,
    );
    if (cappedResult !== undefined) return cappedResult;

    const completedResult = finishAfterPage(
      prepared,
      state,
      pageExceedsBudget,
      nextOffset,
    );
    if (completedResult !== undefined) return completedResult;

    offset = nextOffset;
  }

  return completedSourceRead(prepared, state);
};

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
    return err({
      kind: "invalid_usage",
      message: "--file cannot be empty",
    });
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

import { describeInput } from "../shared/input-diagnostic.ts";
import {
  collectPages,
  listMeta,
  prepareListBounds,
  type ListBounds,
  type ListMeta,
} from "../pagination/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type { TaskReadError } from "../tasks/index.ts";
import {
  prepareCommentTarget,
  projectCommentFields,
  type Comment,
  type CommentPreparationError,
} from "./shared.ts";

export type TaskCommentListMeta = ListMeta;

type TaskCommentsReadMode =
  | Readonly<{ kind: "capped"; resultCap: number; offset?: string }>
  | Readonly<{ kind: "all"; offset?: string }>
  | Readonly<{ kind: "latest"; count: number }>;

type TaskCommentsReadOptions = Readonly<{
  fields?: string;
  max?: string;
  offset?: string;
  all?: boolean;
  latest?: string;
}>;

type PreparedTaskCommentsReadMode = Readonly<{
  scanCap: number;
  mode: TaskCommentsReadMode;
}>;

export type PreparedTaskCommentsRead = Readonly<{
  taskId: string;
  outputFields: readonly string[];
  requestFields: readonly string[];
  scanCap: number;
  mode: TaskCommentsReadMode;
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

interface CommentScanState {
  comments: Comment[];
  scanned: number;
}

const DEFAULT_SCAN_CAP = 100;
const RESOURCE_SUBTYPE_FIELD = "resource_subtype";

const parsePositiveSafeInteger = (
  input: string,
  flag: string,
): Result<number, Readonly<{ kind: "invalid_usage"; message: string }>> => {
  if (!/^\d+$/.test(input)) {
    return err({
      kind: "invalid_usage",
      message: `${flag} must be a positive safe integer. Got ${describeInput(input)}`,
    });
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return err({
      kind: "invalid_usage",
      message: `${flag} must be a positive safe integer. Got ${describeInput(input)}`,
    });
  }
  return ok(value);
};

const withInternalFields = (fields: readonly string[]): readonly string[] =>
  fields.includes(RESOURCE_SUBTYPE_FIELD)
    ? fields
    : [...fields, RESOURCE_SUBTYPE_FIELD];

const resolvedCommentsScanCap = (
  input: string | undefined,
): Result<number, CommentPreparationError> =>
  input === undefined
    ? ok(DEFAULT_SCAN_CAP)
    : parsePositiveSafeInteger(input, "--max");

const prepareLatestCommentsReadMode = (
  options: TaskCommentsReadOptions,
  latestInput: string,
): Result<PreparedTaskCommentsReadMode, CommentPreparationError> => {
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
      message: "--latest requires --max (e.g. --latest 10 --max 200)",
    });
  }

  const count = parsePositiveSafeInteger(latestInput, "--latest");
  if (!count.ok) return count;

  const scanCap = resolvedCommentsScanCap(options.max);
  if (!scanCap.ok) return scanCap;

  return ok({
    scanCap: scanCap.value,
    mode: { kind: "latest", count: count.value },
  });
};

const prepareTaskCommentsReadMode = (
  options: TaskCommentsReadOptions,
): Result<PreparedTaskCommentsReadMode, CommentPreparationError> => {
  if (options.offset === "") {
    return err({ kind: "invalid_usage", message: "--offset cannot be empty" });
  }
  if (options.latest !== undefined) {
    return prepareLatestCommentsReadMode(options, options.latest);
  }

  const bounds = prepareListBounds(options);
  if (!bounds.ok) return bounds;
  const { scanCap, resultCap, offset } = bounds.value;
  const cursor = offset === undefined ? {} : { offset };
  return ok({
    scanCap,
    mode:
      resultCap === undefined
        ? { kind: "all", ...cursor }
        : { kind: "capped", resultCap, ...cursor },
  });
};

export const prepareTaskCommentsRead = (
  taskIdInput: string,
  options: TaskCommentsReadOptions,
): Result<PreparedTaskCommentsRead, CommentPreparationError> => {
  const target = prepareCommentTarget(taskIdInput, options.fields);
  if (!target.ok) return target;
  const preparedMode = prepareTaskCommentsReadMode(options);
  if (!preparedMode.ok) return preparedMode;

  return ok({
    taskId: target.value.taskId,
    outputFields: target.value.outputFields,
    requestFields: withInternalFields(target.value.outputFields),
    ...preparedMode.value,
  });
};

const completedLatestCommentsRead = (
  state: CommentScanState,
  scanCap: number,
): TaskCommentsReadResult =>
  ok({
    comments: [...state.comments].reverse(),
    meta: listMeta(state.scanned, state.comments.length, scanCap),
  });

const storyPaginationError = {
  kind: "invalid_response",
  message: "Story pagination did not advance",
} as const;

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

const executeLatestCommentsRead = async (
  token: string,
  prepared: PreparedTaskCommentsRead,
  count: number,
  reader: TaskStoryGateway,
): Promise<TaskCommentsReadResult> => {
  const state: CommentScanState = { comments: [], scanned: 0 };
  const requestedOffsets = new Set<string>();
  let offset: string | undefined;

  while (state.scanned < prepared.scanCap) {
    if (offset !== undefined) requestedOffsets.add(offset);
    const remaining = prepared.scanCap - state.scanned;
    const page = await reader.getTaskStories(token, prepared.taskId, {
      fields: prepared.requestFields,
      limit: Math.min(100, remaining),
      ...(offset === undefined ? {} : { offset }),
    });
    if (!page.ok) return page;

    const { stories, nextOffset } = page.value;
    if (
      nextOffset !== undefined &&
      (stories.length === 0 || requestedOffsets.has(nextOffset))
    ) {
      return err(storyPaginationError);
    }

    collectLatestComments(
      stories.slice(0, remaining),
      prepared.outputFields,
      count,
      state,
    );
    if (nextOffset === undefined && stories.length <= remaining) {
      return completedLatestCommentsRead(state, prepared.scanCap);
    }
    offset = nextOffset;
  }

  return err({
    kind: "scan_limit",
    message: `Reached --max=${prepared.scanCap} before confirming the newest ${count} comment(s); rerun with a higher --max`,
  });
};

export const executeTaskCommentsRead = async (
  token: string,
  prepared: PreparedTaskCommentsRead,
  dependencies: Readonly<{ reader: TaskStoryGateway }>,
): Promise<TaskCommentsReadResult> => {
  const { mode, scanCap, taskId, outputFields, requestFields } = prepared;
  const { reader } = dependencies;
  if (mode.kind === "latest") {
    return executeLatestCommentsRead(token, prepared, mode.count, reader);
  }

  const bounds: ListBounds = {
    scanCap,
    ...(mode.kind === "capped" ? { resultCap: mode.resultCap } : {}),
    ...(mode.offset === undefined ? {} : { offset: mode.offset }),
  };
  const result = await collectPages<Comment, Comment, TaskReadError>(
    bounds,
    async (limit, offset) => {
      const page = await reader.getTaskStories(token, taskId, {
        fields: requestFields,
        limit,
        ...(offset === undefined ? {} : { offset }),
      });
      if (!page.ok) return page;
      const { stories, nextOffset } = page.value;
      return ok({ items: stories, nextOffset });
    },
    (story) =>
      story.resource_subtype === "comment_added"
        ? projectCommentFields(story, outputFields)
        : undefined,
    storyPaginationError,
  );
  return result.ok
    ? ok({ comments: result.value.items, meta: result.value.meta })
    : result;
};

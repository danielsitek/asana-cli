import { err, ok, type Result } from "../shared/result.ts";
import type {
  PreparedTaskListRead,
  TaskListAssigneeFilter,
  TaskListOptions,
  TaskListSource,
} from "./index.ts";

const TASK_LIST_SCAN_CAP_DEFAULT = 100;
const TASK_LIST_RESULT_CAP_DEFAULT = 20;

export type TaskListPreparationError = Readonly<{
  kind: "invalid_usage";
  message: string;
}>;

export type TaskListBounds = Readonly<{
  scanCap: number;
  resultCap?: number;
}>;

const parseTaskListMax = (
  input: string,
): Result<number, TaskListPreparationError> => {
  if (!/^\d+$/.test(input)) {
    return err({
      kind: "invalid_usage",
      message: "--max must be a positive safe integer",
    });
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return err({
      kind: "invalid_usage",
      message: "--max must be a positive safe integer",
    });
  }
  return ok(value);
};

const withTaskListInternalFields = (
  fields: readonly string[],
  needsAssignee: boolean,
): readonly string[] => {
  const withCompleted = fields.includes("completed")
    ? fields
    : [...fields, "completed"];
  if (!needsAssignee || withCompleted.includes("assignee.gid")) {
    return withCompleted;
  }
  return [...withCompleted, "assignee.gid"];
};

export const prepareTaskListBounds = (
  options: Pick<TaskListOptions, "all" | "max">,
): Result<TaskListBounds, TaskListPreparationError> => {
  if (options.all && options.max === undefined) {
    return err({ kind: "invalid_usage", message: "--all requires --max" });
  }
  const scanCap =
    options.max === undefined
      ? ok(TASK_LIST_SCAN_CAP_DEFAULT)
      : parseTaskListMax(options.max);
  return scanCap.ok
    ? ok({
        scanCap: scanCap.value,
        ...(options.all ? {} : { resultCap: TASK_LIST_RESULT_CAP_DEFAULT }),
      })
    : scanCap;
};

export const assemblePreparedTaskListRead = (
  source: TaskListSource,
  assigneeFilter: TaskListAssigneeFilter | undefined,
  completed: boolean,
  outputFields: readonly string[],
  bounds: TaskListBounds,
): PreparedTaskListRead => ({
  source,
  ...(assigneeFilter === undefined ? {} : { assigneeFilter }),
  completed,
  outputFields,
  requestFields: withTaskListInternalFields(
    outputFields,
    assigneeFilter !== undefined,
  ),
  ...bounds,
});

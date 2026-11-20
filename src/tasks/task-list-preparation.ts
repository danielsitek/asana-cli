import type { ListBounds } from "../pagination/index.ts";
import type {
  PreparedTaskListRead,
  TaskListAssigneeFilter,
  TaskListSource,
} from "./index.ts";

export type TaskListPreparationError = Readonly<{
  kind: "invalid_usage";
  message: string;
}>;

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

export const assemblePreparedTaskListRead = (
  source: TaskListSource,
  assigneeFilter: TaskListAssigneeFilter | undefined,
  completed: boolean,
  outputFields: readonly string[],
  bounds: ListBounds,
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

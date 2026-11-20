import {
  prepareListBounds,
  type ListBounds,
  type ListMeta,
  type ListOptions,
} from "../pagination/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type {
  ResourceSelector,
  Task,
  TaskReadError,
  TaskUpdateError,
} from "./index.ts";
import { parseTaskId, prepareSelectedFields } from "./task-input.ts";

type TaskListPreparationError = Readonly<{
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

const assemblePreparedTaskListRead = (
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

export type TaskListSource = Readonly<
  | { kind: "section"; sectionGid: string }
  | { kind: "project"; projectGid: string }
  | { kind: "parent"; parentGid: string }
  | { kind: "my_section"; selector: ResourceSelector }
>;

export type TaskListOptions = ListOptions &
  Readonly<{
    mySection?: string;
    section?: string;
    project?: string;
    parent?: string;
    assignee?: string;
    completed?: string;
  }>;

export type TaskListAssigneeFilter = Readonly<
  { kind: "me" } | { kind: "gid"; value: string }
>;

export type TaskListMeta = ListMeta;

export type PreparedTaskListRead = ListBounds &
  Readonly<{
    source: TaskListSource;
    assigneeFilter?: TaskListAssigneeFilter;
    completed: boolean;
    outputFields: readonly string[];
    requestFields: readonly string[];
  }>;

export type TaskListPage = Readonly<{
  tasks: readonly Task[];
  nextOffset?: string;
}>;

export interface TaskListGateway {
  getSectionTasks(
    token: string,
    sectionGid: string,
    options: Readonly<{
      fields: readonly string[];
      limit: number;
      offset?: string;
      completedSince: string;
    }>,
  ): Promise<Result<TaskListPage, TaskReadError>>;

  getProjectTasks(
    token: string,
    projectGid: string,
    options: Readonly<{
      fields: readonly string[];
      limit: number;
      offset?: string;
      completedSince: string;
    }>,
  ): Promise<Result<TaskListPage, TaskReadError>>;

  getTaskSubtasks(
    token: string,
    parentGid: string,
    options: Readonly<{
      fields: readonly string[];
      limit: number;
      offset?: string;
    }>,
  ): Promise<Result<TaskListPage, TaskReadError>>;
}

export type ResolvedMySection = Readonly<{ sectionGid: string }>;

export interface MySectionResolver {
  resolve(
    token: string,
    selector: ResourceSelector,
  ): Promise<Result<ResolvedMySection, TaskUpdateError>>;
}

export type TaskListDependencies = Readonly<{
  reader: TaskListGateway;
  mySectionResolver?: MySectionResolver;
  resolveAuthenticatedUserGid: (
    token: string,
  ) => Promise<Result<string, TaskReadError>>;
}>;

export const DEFAULT_TASK_LIST_FIELDS = [
  "gid",
  "name",
  "completed",
  "assignee.gid",
  "assignee.name",
] as const;

const prepareMySectionTaskListSource = (
  input: string,
): Result<TaskListSource, TaskListPreparationError> => {
  if (!input.startsWith("@") || input.length <= 1) {
    return err({
      kind: "invalid_usage",
      message: "--my-section must use an @alias",
    });
  }
  return ok({
    kind: "my_section",
    selector: { kind: "alias", value: input.slice(1) },
  });
};

const prepareParentTaskListSource = (
  input: string | undefined,
): Result<TaskListSource, TaskListPreparationError> => {
  const parent = input === undefined ? undefined : parseTaskId(input);
  return parent?.ok
    ? ok({ kind: "parent", parentGid: parent.value })
    : err({
        kind: "invalid_usage",
        message: "--parent must use a digit-only GID or Asana task URL",
      });
};

const prepareTaskListSource = (
  options: TaskListOptions,
): Result<TaskListSource, TaskListPreparationError> => {
  const supplied = [
    options.mySection,
    options.section,
    options.project,
    options.parent,
  ].filter((value) => value !== undefined).length;
  if (supplied !== 1) {
    return err({
      kind: "invalid_usage",
      message:
        "Exactly one of --my-section, --section, --project, or --parent is required",
    });
  }
  if (options.mySection !== undefined) {
    return prepareMySectionTaskListSource(options.mySection);
  }
  if (options.section !== undefined) {
    return /^\d+$/.test(options.section)
      ? ok({ kind: "section", sectionGid: options.section })
      : err({
          kind: "invalid_usage",
          message: "--section must be a digit-only GID",
        });
  }
  if (options.project !== undefined) {
    return /^\d+$/.test(options.project)
      ? ok({ kind: "project", projectGid: options.project })
      : err({
          kind: "invalid_usage",
          message: "--project must be a digit-only GID",
        });
  }
  return prepareParentTaskListSource(options.parent);
};

const prepareTaskListAssignee = (
  input: string | undefined,
): Result<TaskListAssigneeFilter | undefined, TaskListPreparationError> => {
  if (input === undefined) return ok(undefined);
  if (input === "me") return ok({ kind: "me" });
  if (/^\d+$/.test(input)) return ok({ kind: "gid", value: input });
  return err({
    kind: "invalid_usage",
    message: "--assignee must be me or a digit-only user GID",
  });
};

const prepareTaskListCompleted = (
  input: string | undefined,
): Result<boolean, TaskListPreparationError> => {
  if (input === undefined) return ok(false);
  if (input === "true" || input === "false") return ok(input === "true");
  return err({
    kind: "invalid_usage",
    message: "--completed must be true or false",
  });
};

export const prepareTaskListRead = (
  options: TaskListOptions,
  fieldsInput?: string,
): Result<
  PreparedTaskListRead,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  const source = prepareTaskListSource(options);
  if (!source.ok) return source;
  const assigneeFilter = prepareTaskListAssignee(options.assignee);
  if (!assigneeFilter.ok) return assigneeFilter;
  const completed = prepareTaskListCompleted(options.completed);
  if (!completed.ok) return completed;
  const bounds = prepareListBounds(options);
  if (!bounds.ok) return bounds;
  const selectedFields = prepareSelectedFields(fieldsInput);
  if (!selectedFields.ok) return selectedFields;
  const outputFields = selectedFields.value ?? DEFAULT_TASK_LIST_FIELDS;
  return ok(
    assemblePreparedTaskListRead(
      source.value,
      assigneeFilter.value,
      completed.value,
      outputFields,
      bounds.value,
    ),
  );
};

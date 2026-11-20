import { ok, type Result } from "../shared/result.ts";

export { executeTaskCreation, executeTaskUpdate } from "./mutation-workflow.ts";
export { parseTaskId, validateFieldList } from "./task-input.ts";
export {
  DEFAULT_TASK_LIST_FIELDS,
  prepareTaskListRead,
  type MySectionResolver,
  type PreparedTaskListRead,
  type ResolvedMySection,
  type TaskListAssigneeFilter,
  type TaskListDependencies,
  type TaskListGateway,
  type TaskListMeta,
  type TaskListOptions,
  type TaskListPage,
  type TaskListSource,
} from "./task-list-preparation.ts";
export { executeTaskListRead } from "./task-list-read.ts";
export {
  prepareTaskCreate,
  prepareTaskCreateWithConfig,
  prepareTaskParentUpdate,
  prepareTaskUpdate,
} from "./task-mutation-preparation.ts";

export type Task = Readonly<{
  gid?: string;
  name?: string;
  notes?: string;
  completed?: boolean;
  due_on?: string | null;
  assignee?: Readonly<{
    gid?: string;
    name?: string;
    [key: string]: unknown;
  }> | null;
  [key: string]: unknown;
}>;

export type WriteOutcomeUnknown = Readonly<{
  kind: "outcome_unknown";
  message: string;
  retryable: false;
  hint: string;
  status?: number;
}>;

export type TaskReadError = Readonly<{
  kind:
    | "authentication"
    | "api"
    | "not_found"
    | "rate_limit"
    | "network"
    | "invalid_response";
  message: string;
  status?: number;
}>;

export type TaskWriteError = TaskReadError | WriteOutcomeUnknown;

export interface TaskGateway {
  getTask(
    token: string,
    taskId: string,
    fields: readonly string[],
  ): Promise<Result<Task, TaskReadError>>;
}

export type TaskMutation = Readonly<{
  name?: string;
  notes?: string;
  assignee?: string | null;
  due_on?: string | null;
  completed?: boolean;
  assignee_section?: string;
  custom_fields?: Readonly<Record<string, number | string | null>>;
}>;

export type TaskUpdateOptions = Readonly<{
  name?: string;
  notes?: string;
  notesFile?: string;
  assignee?: string;
  dueOn?: string;
  completed?: string;
  mySection?: string;
  section?: string;
  project?: string;
  customFields?: readonly string[];
}>;

export interface TaskMutationGateway {
  updateTask(
    token: string,
    taskId: string,
    mutation: TaskMutation,
    fields?: readonly string[],
  ): Promise<Result<Task, TaskReadError>>;
}

export interface TaskCreationGateway {
  createTask(
    token: string,
    target: TaskCreationTarget,
    mutation: TaskMutation,
    fields?: readonly string[],
  ): Promise<Result<Task & Readonly<{ gid: string }>, TaskWriteError>>;
}

export interface TaskParentMutationGateway {
  setTaskParent(
    token: string,
    taskId: string,
    parentId: string | null,
    fields?: readonly string[],
  ): Promise<Result<Task, TaskWriteError>>;
}

export interface TaskSectionMutationGateway {
  moveTaskToSection(
    token: string,
    taskId: string,
    sectionGid: string,
    fields?: readonly string[],
  ): Promise<Result<Task, TaskWriteError>>;
}

export interface TaskProjectMutationGateway {
  addTaskToProject(
    token: string,
    taskId: string,
    projectGid: string,
    fields?: readonly string[],
  ): Promise<Result<Task, TaskWriteError>>;
}

export type TaskParentUpdateOptions = Readonly<{ parent: string }>;

export type PreparedTaskParentUpdate = Readonly<{
  taskId: string;
  parentId: string | null;
  fields?: readonly string[];
}>;

export type TaskParentUpdateDependencies = Readonly<{
  writer: TaskParentMutationGateway;
}>;

export type TaskParentUpdateResult = Readonly<{
  task: Task;
  applied: Readonly<{ parent: string | null }>;
}>;

export type TaskCreationTarget = Readonly<
  | { kind: "subtask"; parentId: string }
  | { kind: "workspace"; workspaceGid: string }
  | { kind: "project"; projectGid: string }
  | { kind: "section"; sectionGid: string }
>;

type TaskMaterializationDependencies = Readonly<{
  myTasksMutationResolver?: MyTasksMutationResolver;
  resolveAuthenticatedUserGid: (
    token: string,
  ) => Promise<Result<string, TaskReadError>>;
  readFile: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
}>;

export type TaskUpdateDependencies = TaskMaterializationDependencies &
  Readonly<{
    writer: TaskMutationGateway;
    sectionWriter?: TaskSectionMutationGateway;
    projectWriter?: TaskProjectMutationGateway;
    projectCustomFieldResolver?: ProjectCustomFieldResolver;
  }>;

export type TaskUpdateError =
  | Readonly<{ kind: "invalid_usage"; message: string }>
  | Readonly<{ kind: "internal_error"; message: string }>
  | Readonly<{ kind: "configuration"; message: string }>
  | TaskWriteError;

export type MyTasksMutationError = TaskUpdateError;

export type TaskUpdateResult = Readonly<{
  task: Task;
  applied: TaskMutation & Readonly<{ section?: string; project?: string }>;
}>;

export type PreparedTaskUpdate = Readonly<{
  taskId: string;
  mutation: TaskMutation;
  notesFile?: string;
  resolveAssigneeMe: boolean;
  mySection?: ResourceSelector;
  sectionGid?: string;
  projectGid?: string;
  customFields: readonly PreparedCustomField[];
  fields?: readonly string[];
}>;

export type TaskCreateOptions = TaskUpdateOptions &
  Readonly<{ parent?: string; project?: string }>;

export type PreparedTaskCreate = Readonly<{
  target: TaskCreationTarget;
  mutation: TaskMutation & Readonly<{ name: string }>;
  notesFile?: string;
  resolveAssigneeMe: boolean;
  mySection?: ResourceSelector;
  customFields: readonly PreparedCustomField[];
  fields?: readonly string[];
}>;

export type TaskCreationStageName =
  | "create"
  | "assignee"
  | "my_section"
  | "custom_fields";

export type TaskCreationStage = Readonly<{
  stage: TaskCreationStageName;
  status: "completed" | "failed" | "not_run";
  applied?: TaskMutation;
  error?: Readonly<{ kind: TaskReadError["kind"]; message: string }>;
  reason?: "not_requested" | "stopped_after_failure";
}>;

export type TaskCreationResult = Readonly<{
  task: Task;
  stages: readonly TaskCreationStage[];
  complete: boolean;
}>;

export type TaskCreationDependencies = TaskMaterializationDependencies &
  Readonly<{
    creator: TaskCreationGateway;
    writer?: TaskMutationGateway;
  }>;

export type ResourceSelector = Readonly<
  { kind: "gid"; value: string } | { kind: "alias"; value: string }
>;

export type PreparedCustomField = Readonly<{
  field: ResourceSelector;
  value: string | null;
}>;

export type MyTasksMutationRequest = Readonly<{
  token: string;
  taskId?: string;
  finalAssignee?: string | null;
  authenticatedUserGid?: string;
  mySection?: ResourceSelector;
  customFields: readonly PreparedCustomField[];
}>;

export type MyTasksMutationResult = Readonly<{
  assignee_section?: string;
  custom_fields?: Readonly<Record<string, number | string | null>>;
}>;

export interface MyTasksMutationResolver {
  resolve(
    request: MyTasksMutationRequest,
  ): Promise<Result<MyTasksMutationResult, MyTasksMutationError>>;
}

export interface ProjectCustomFieldResolver {
  resolve(
    token: string,
    taskId: string,
    fields: readonly PreparedCustomField[],
  ): Promise<
    Result<
      Readonly<{
        resolved: Readonly<Record<string, number | string | null>>;
        remaining: readonly PreparedCustomField[];
      }>,
      TaskUpdateError
    >
  >;
}

export const executeTaskParentUpdate = async (
  token: string,
  prepared: PreparedTaskParentUpdate,
  dependencies: TaskParentUpdateDependencies,
): Promise<Result<TaskParentUpdateResult, TaskUpdateError>> => {
  const updated = await dependencies.writer.setTaskParent(
    token,
    prepared.taskId,
    prepared.parentId,
    prepared.fields,
  );
  return updated.ok
    ? ok({ task: updated.value, applied: { parent: prepared.parentId } })
    : updated;
};

export const DEFAULT_FIELDS = [
  "gid",
  "name",
  "notes",
  "completed",
  "due_on",
  "assignee.gid",
  "assignee.name",
] as const;

import { err, ok, type Result } from "../shared/result.ts";
import { projectFields } from "../utils/project-fields.ts";
import {
  assembleParsedTaskCreate,
  finalizeExplicitTaskCreate,
  prepareConfiguredTaskCreate,
  validateTaskCreationTarget,
  type ParsedTaskCreate,
  type PreparedTaskMutation,
  type TaskCreateConfigResolver,
  type TaskCreatePreparationError,
} from "./task-create-workflow.ts";

export { executeTaskCreation, executeTaskUpdate } from "./mutation-workflow.ts";

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
  ): Promise<Result<Task & Readonly<{ gid: string }>, TaskReadError>>;
}

export interface TaskParentMutationGateway {
  setTaskParent(
    token: string,
    taskId: string,
    parentId: string | null,
    fields?: readonly string[],
  ): Promise<Result<Task, TaskReadError>>;
}

export interface TaskSectionMutationGateway {
  moveTaskToSection(
    token: string,
    taskId: string,
    sectionGid: string,
    fields?: readonly string[],
  ): Promise<Result<Task, TaskReadError>>;
}

export interface TaskProjectMutationGateway {
  addTaskToProject(
    token: string,
    taskId: string,
    projectGid: string,
    fields?: readonly string[],
  ): Promise<Result<Task, TaskReadError>>;
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
  }>;

export type TaskUpdateError =
  | Readonly<{ kind: "invalid_usage"; message: string }>
  | Readonly<{ kind: "internal_error"; message: string }>
  | Readonly<{ kind: "configuration"; message: string }>
  | TaskReadError;

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

const parseResourceSelector = (
  input: string,
  flag: string,
): Result<ResourceSelector, string> => {
  if (/^\d+$/.test(input)) return ok({ kind: "gid", value: input });
  if (input.startsWith("@") && input.length > 1) {
    return ok({ kind: "alias", value: input.slice(1) });
  }
  return err(`${flag} must use a digit-only GID or @alias`);
};

const parseCustomField = (
  input: string,
): Result<PreparedCustomField, string> => {
  const delimiter = input.indexOf(":");
  if (delimiter <= 0) {
    return err("--custom-field must use <field-gid|@alias>:<value>");
  }
  const field = parseResourceSelector(
    input.slice(0, delimiter),
    "--custom-field",
  );
  if (!field.ok) return field;
  const rawValue = input.slice(delimiter + 1);
  if (rawValue === "") {
    return err("--custom-field value must not be empty");
  }
  const value = rawValue === "null" ? null : rawValue;
  return ok({ field: field.value, value });
};

const realDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const prepareSelectedFields = (
  fieldsInput: string | undefined,
): Result<
  readonly string[] | undefined,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  if (fieldsInput === undefined) return ok(undefined);
  const validated = validateFieldList(fieldsInput);
  return validated.ok
    ? ok(validated.value)
    : err({ kind: "invalid_usage", message: validated.error });
};

export const prepareTaskUpdate = (
  taskIdInput: string,
  options: TaskUpdateOptions,
  fieldsInput?: string,
): Result<
  PreparedTaskUpdate,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  const fields = prepareSelectedFields(fieldsInput);
  if (!fields.ok) return fields;

  const taskId = parseTaskId(taskIdInput);
  if (!taskId.ok) return err({ kind: "invalid_usage", message: taskId.error });

  const placementFlag =
    options.section !== undefined
      ? "--section"
      : options.project !== undefined
        ? "--project"
        : undefined;
  if (placementFlag !== undefined) {
    const combined = (Object.keys(options) as (keyof typeof options)[]).some(
      (key) => {
        const value = options[key];
        return (
          key !== placementFlag.slice(2) &&
          value !== undefined &&
          (key !== "customFields" || value.length > 0)
        );
      },
    );
    if (combined) {
      return err({
        kind: "invalid_usage",
        message: `${placementFlag} cannot be combined with other task update flags`,
      });
    }
  }

  const prepared = prepareTaskMutation(options);
  if (!prepared.ok) return prepared;
  return ok({
    taskId: taskId.value,
    ...prepared.value,
    ...(fields.value === undefined ? {} : { fields: fields.value }),
  });
};

export const prepareTaskParentUpdate = (
  taskIdInput: string,
  options: TaskUpdateOptions & TaskParentUpdateOptions,
  fieldsInput?: string,
): Result<
  PreparedTaskParentUpdate,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  const fields = prepareSelectedFields(fieldsInput);
  if (!fields.ok) return fields;
  const selected = fields.value === undefined ? {} : { fields: fields.value };

  // Object.entries() loses the per-property `| undefined` from optional
  // fields, so it can't tell us a flag was actually left unset; index via
  // the original keys instead to keep that information.
  const combined = (Object.keys(options) as (keyof typeof options)[]).some(
    (key) => {
      const value = options[key];
      return (
        key !== "parent" &&
        value !== undefined &&
        (key !== "customFields" || value.length > 0)
      );
    },
  );
  if (combined) {
    return err({
      kind: "invalid_usage",
      message: "--parent cannot be combined with other task update flags",
    });
  }

  const taskId = parseTaskId(taskIdInput);
  if (!taskId.ok) return err({ kind: "invalid_usage", message: taskId.error });

  if (options.parent === "null") {
    return ok({ taskId: taskId.value, parentId: null, ...selected });
  }
  const parentId = parseTaskId(options.parent);
  if (!parentId.ok) {
    return err({ kind: "invalid_usage", message: "Invalid parent identifier" });
  }
  if (parentId.value === taskId.value) {
    return err({
      kind: "invalid_usage",
      message: "--parent cannot reference the task itself",
    });
  }
  return ok({ taskId: taskId.value, parentId: parentId.value, ...selected });
};

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

type TaskMutationPreparationError = Readonly<{
  kind: "invalid_usage";
  message: string;
}>;

const hasTaskMutation = (options: TaskUpdateOptions): boolean =>
  (Object.keys(options) as (keyof typeof options)[]).some((key) => {
    const value = options[key];
    return value !== undefined && (key !== "customFields" || value.length > 0);
  });

const validateNotesOptions = (
  options: TaskUpdateOptions,
): Result<void, TaskMutationPreparationError> =>
  options.notes !== undefined && options.notesFile !== undefined
    ? err({
        kind: "invalid_usage",
        message: "--notes and --notes-file are mutually exclusive",
      })
    : ok(undefined);

type PreparedAssignee = Readonly<{
  mutation: Pick<TaskMutation, "assignee">;
  resolveAssigneeMe: boolean;
}>;

const prepareAssignee = (
  assignee: string | undefined,
): Result<PreparedAssignee, TaskMutationPreparationError> => {
  if (assignee === undefined) {
    return ok({ mutation: {}, resolveAssigneeMe: false });
  }
  if (assignee === "me") {
    return ok({ mutation: {}, resolveAssigneeMe: true });
  }
  if (assignee === "null") {
    return ok({ mutation: { assignee: null }, resolveAssigneeMe: false });
  }
  return /^\d+$/.test(assignee)
    ? ok({ mutation: { assignee }, resolveAssigneeMe: false })
    : err({
        kind: "invalid_usage",
        message: "--assignee must be me, null, or a digit-only user GID",
      });
};

const prepareMySection = (
  input: string | undefined,
): Result<ResourceSelector | undefined, TaskMutationPreparationError> => {
  if (input === undefined) return ok(undefined);
  const parsed = parseResourceSelector(input, "--my-section");
  return parsed.ok
    ? parsed
    : err({ kind: "invalid_usage", message: parsed.error });
};

type PreparedPlacement = Readonly<{
  sectionGid?: string;
  projectGid?: string;
}>;

const preparePlacement = (
  options: Pick<TaskUpdateOptions, "section" | "project" | "mySection">,
): Result<PreparedPlacement, TaskMutationPreparationError> => {
  if (options.section !== undefined && !/^\d+$/.test(options.section)) {
    return err({
      kind: "invalid_usage",
      message: "--section must be a digit-only section GID",
    });
  }
  if (options.project !== undefined && !/^\d+$/.test(options.project)) {
    return err({
      kind: "invalid_usage",
      message: "--project must be a digit-only project GID",
    });
  }
  if (options.section !== undefined && options.mySection !== undefined) {
    return err({
      kind: "invalid_usage",
      message: "--section and --my-section are mutually exclusive",
    });
  }
  return ok({
    ...(options.section === undefined ? {} : { sectionGid: options.section }),
    ...(options.project === undefined ? {} : { projectGid: options.project }),
  });
};

const prepareCustomFields = (
  inputs: readonly string[] | undefined,
): Result<readonly PreparedCustomField[], TaskMutationPreparationError> => {
  const customFields: PreparedCustomField[] = [];
  const seenSelectors = new Set<string>();
  for (const input of inputs ?? []) {
    const parsed = parseCustomField(input);
    if (!parsed.ok) {
      return err({ kind: "invalid_usage", message: parsed.error });
    }
    const selectorKey = `${parsed.value.field.kind}:${parsed.value.field.value}`;
    if (seenSelectors.has(selectorKey)) {
      return err({
        kind: "invalid_usage",
        message: "--custom-field cannot update the same field more than once",
      });
    }
    seenSelectors.add(selectorKey);
    customFields.push(parsed.value);
  }
  return ok(customFields);
};

const prepareDueDate = (
  dueOn: string | undefined,
): Result<Pick<TaskMutation, "due_on">, TaskMutationPreparationError> => {
  if (dueOn === undefined) return ok({});
  if (dueOn === "null") return ok({ due_on: null });
  return realDate(dueOn)
    ? ok({ due_on: dueOn })
    : err({
        kind: "invalid_usage",
        message: "--due-on must be a real YYYY-MM-DD date or null",
      });
};

const prepareCompletion = (
  completed: string | undefined,
): Result<Pick<TaskMutation, "completed">, TaskMutationPreparationError> => {
  if (completed === undefined) return ok({});
  if (completed === "true") return ok({ completed: true });
  if (completed === "false") return ok({ completed: false });
  return err({
    kind: "invalid_usage",
    message: "--completed must be true or false",
  });
};

type PreparedTaskMutationParts = Readonly<{
  assignee: PreparedAssignee;
  mySection: ResourceSelector | undefined;
  placement: PreparedPlacement;
  customFields: readonly PreparedCustomField[];
  dueDate: Pick<TaskMutation, "due_on">;
  completion: Pick<TaskMutation, "completed">;
}>;

const assembleTaskMutation = (
  options: TaskUpdateOptions,
  parts: PreparedTaskMutationParts,
): PreparedTaskMutation => ({
  mutation: {
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.notes === undefined ? {} : { notes: options.notes }),
    ...parts.assignee.mutation,
    ...parts.dueDate,
    ...parts.completion,
  },
  ...(options.notesFile === undefined ? {} : { notesFile: options.notesFile }),
  resolveAssigneeMe: parts.assignee.resolveAssigneeMe,
  ...(parts.mySection === undefined ? {} : { mySection: parts.mySection }),
  ...parts.placement,
  customFields: parts.customFields,
});

const prepareTaskMutation = (
  options: TaskUpdateOptions,
): Result<PreparedTaskMutation, TaskMutationPreparationError> => {
  // See prepareTaskParentUpdate: index via keys, not Object.entries(), to
  // keep the `| undefined` that optional properties actually carry.
  if (!hasTaskMutation(options)) {
    return err({
      kind: "invalid_usage",
      message: "At least one task mutation is required",
    });
  }

  const notes = validateNotesOptions(options);
  if (!notes.ok) return notes;
  const assignee = prepareAssignee(options.assignee);
  if (!assignee.ok) return assignee;
  const mySection = prepareMySection(options.mySection);
  if (!mySection.ok) return mySection;
  const placement = preparePlacement(options);
  if (!placement.ok) return placement;
  const customFields = prepareCustomFields(options.customFields);
  if (!customFields.ok) return customFields;
  const dueDate = prepareDueDate(options.dueOn);
  if (!dueDate.ok) return dueDate;
  const completion = prepareCompletion(options.completed);
  if (!completion.ok) return completion;

  return ok(
    assembleTaskMutation(options, {
      assignee: assignee.value,
      mySection: mySection.value,
      placement: placement.value,
      customFields: customFields.value,
      dueDate: dueDate.value,
      completion: completion.value,
    }),
  );
};

const parseTaskCreationTarget = (
  options: TaskCreateOptions,
): Result<
  TaskCreationTarget | undefined,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  if (options.parent !== undefined) {
    const parentId = parseTaskId(options.parent);
    return parentId.ok
      ? ok({ kind: "subtask", parentId: parentId.value })
      : err({ kind: "invalid_usage", message: parentId.error });
  }
  if (options.project !== undefined) {
    return /^\d+$/.test(options.project)
      ? ok({ kind: "project", projectGid: options.project })
      : err({
          kind: "invalid_usage",
          message: "--project must be a digit-only project GID",
        });
  }
  return ok(
    options.section === undefined
      ? undefined
      : { kind: "section", sectionGid: options.section },
  );
};

const parseTaskCreateInput = (
  options: TaskCreateOptions,
  fieldsInput?: string,
): Result<
  ParsedTaskCreate,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  const fields = prepareSelectedFields(fieldsInput);
  if (!fields.ok) return fields;
  if (options.name === undefined) {
    return err({ kind: "invalid_usage", message: "--name is required" });
  }
  const validTarget = validateTaskCreationTarget(options);
  if (!validTarget.ok) return validTarget;
  const prepared = prepareTaskMutation(options);
  if (!prepared.ok) return prepared;
  const target = parseTaskCreationTarget(options);
  if (!target.ok) return target;
  return ok(
    assembleParsedTaskCreate(
      options.name,
      prepared.value,
      target.value,
      fields.value,
    ),
  );
};

export const prepareTaskCreate = (
  options: TaskCreateOptions,
  fieldsInput?: string,
): Result<PreparedTaskCreate, TaskCreatePreparationError> => {
  const prepared = parseTaskCreateInput(options, fieldsInput);
  if (!prepared.ok) return prepared;
  return finalizeExplicitTaskCreate(prepared.value);
};

export const prepareTaskCreateWithConfig = async (
  options: TaskCreateOptions,
  resolveConfig?: TaskCreateConfigResolver,
  fieldsInput?: string,
): Promise<Result<PreparedTaskCreate, TaskCreatePreparationError>> => {
  const prepared = parseTaskCreateInput(options, fieldsInput);
  if (!prepared.ok) return prepared;
  return prepareConfiguredTaskCreate(options, prepared.value, resolveConfig);
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

export const parseTaskId = (input: string): Result<string, string> => {
  if (/^\d+$/.test(input)) {
    return ok(input);
  }
  const match = input.match(
    /^https:\/\/app\.asana\.com\/0\/(\d+)\/(\d+)(?:\/f)?$/,
  );
  if (match && typeof match[2] === "string") {
    return ok(match[2]);
  }
  return err("Invalid task identifier");
};

export const validateFieldList = (
  input: string,
): Result<readonly string[], string> => {
  if (input.trim() === "") {
    return err("Fields list cannot be empty");
  }
  const segments = input.split(",");
  const processed: string[] = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed === "") {
      return err("Fields list cannot contain empty segments");
    }
    processed.push(trimmed);
  }
  const unique = Array.from(new Set(processed));
  return ok(unique);
};

export type TaskListSource = Readonly<
  | { kind: "section"; sectionGid: string }
  | { kind: "project"; projectGid: string }
  | { kind: "parent"; parentGid: string }
  | { kind: "my_section"; selector: ResourceSelector }
>;

export type TaskListOptions = Readonly<{
  mySection?: string;
  section?: string;
  project?: string;
  parent?: string;
  assignee?: string;
  completed?: string;
  max?: string;
  all?: boolean;
}>;

export type TaskListAssigneeFilter = Readonly<
  { kind: "me" } | { kind: "gid"; value: string }
>;

export type TaskListMeta = Readonly<{
  scanned: number;
  returned: number;
  scan_truncated: boolean;
  next_offset?: string;
}>;

export type PreparedTaskListRead = Readonly<{
  source: TaskListSource;
  assigneeFilter?: TaskListAssigneeFilter;
  completed: boolean;
  outputFields: readonly string[];
  requestFields: readonly string[];
  scanCap: number;
  resultCap?: number;
  offset?: string;
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

const TASK_LIST_SCAN_CAP_DEFAULT = 100;
const TASK_LIST_RESULT_CAP_DEFAULT = 20;
const EPOCH_COMPLETED_SINCE = "1970-01-01T00:00:00.000Z";

const parseTaskListMax = (
  input: string,
): Result<number, Readonly<{ kind: "invalid_usage"; message: string }>> => {
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

type TaskListPreparationError = Readonly<{
  kind: "invalid_usage";
  message: string;
}>;

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

  if (options.all && options.max === undefined) {
    return err({ kind: "invalid_usage", message: "--all requires --max" });
  }

  const scanCap =
    options.max === undefined
      ? ok(TASK_LIST_SCAN_CAP_DEFAULT)
      : parseTaskListMax(options.max);
  if (!scanCap.ok) return scanCap;

  const selectedFields = prepareSelectedFields(fieldsInput);
  if (!selectedFields.ok) return selectedFields;
  const outputFields = selectedFields.value ?? DEFAULT_TASK_LIST_FIELDS;
  const requestFields = withTaskListInternalFields(
    outputFields,
    assigneeFilter.value !== undefined,
  );

  return ok({
    source: source.value,
    ...(assigneeFilter.value === undefined
      ? {}
      : { assigneeFilter: assigneeFilter.value }),
    completed: completed.value,
    outputFields,
    requestFields,
    scanCap: scanCap.value,
    ...(options.all ? {} : { resultCap: TASK_LIST_RESULT_CAP_DEFAULT }),
  });
};

const projectTaskListFields = (task: Task, fields: readonly string[]): Task => {
  const availableFields = fields.filter(
    (field) => projectFields(task, [field]).found,
  );
  const projected = projectFields(task, availableFields);
  return projected.found ? (projected.value as Task) : {};
};

type ResolvedTaskListSource = Readonly<
  | { kind: "section"; gid: string }
  | { kind: "project"; gid: string }
  | { kind: "parent"; gid: string }
>;

type TaskListReadResult = Result<
  Readonly<{ tasks: readonly Task[]; meta: TaskListMeta }>,
  TaskUpdateError
>;

const resolveTaskListSource = async (
  token: string,
  source: TaskListSource,
  resolver: MySectionResolver | undefined,
): Promise<Result<ResolvedTaskListSource, TaskUpdateError>> => {
  if (source.kind !== "my_section") {
    const gid =
      source.kind === "section"
        ? source.sectionGid
        : source.kind === "project"
          ? source.projectGid
          : source.parentGid;
    return ok({ kind: source.kind, gid });
  }
  if (!resolver) {
    return err({
      kind: "internal_error",
      message: "My Tasks section resolution dependencies are unavailable",
    });
  }
  const resolved = await resolver.resolve(token, source.selector);
  return resolved.ok
    ? ok({ kind: "section", gid: resolved.value.sectionGid })
    : resolved;
};

const resolveTaskListAssignee = async (
  token: string,
  filter: TaskListAssigneeFilter | undefined,
  resolveAuthenticatedUserGid: TaskListDependencies["resolveAuthenticatedUserGid"],
): Promise<Result<string | undefined, TaskUpdateError>> => {
  if (filter?.kind === "gid") return ok(filter.value);
  if (filter?.kind === "me") return resolveAuthenticatedUserGid(token);
  return ok(undefined);
};

const readTaskListPage = (
  token: string,
  source: ResolvedTaskListSource,
  prepared: PreparedTaskListRead,
  limit: number,
  offset: string | undefined,
  reader: TaskListGateway,
): Promise<Result<TaskListPage, TaskReadError>> => {
  const options = {
    fields: prepared.requestFields,
    limit,
    ...(offset === undefined ? {} : { offset }),
  };
  if (source.kind === "parent") {
    return reader.getTaskSubtasks(token, source.gid, options);
  }
  const completedSince = prepared.completed ? EPOCH_COMPLETED_SINCE : "now";
  return source.kind === "section"
    ? reader.getSectionTasks(token, source.gid, { ...options, completedSince })
    : reader.getProjectTasks(token, source.gid, { ...options, completedSince });
};

const taskListResult = (
  tasks: readonly Task[],
  scanned: number,
  scanTruncated: boolean,
  nextOffset?: string,
): TaskListReadResult =>
  ok({
    tasks,
    meta: {
      scanned,
      returned: tasks.length,
      scan_truncated: scanTruncated,
      ...(nextOffset === undefined ? {} : { next_offset: nextOffset }),
    },
  });

const collectMatchingPageTasks = (
  pageTasks: readonly Task[],
  prepared: PreparedTaskListRead,
  assigneeGid: string | undefined,
  tasks: Task[],
  remaining: number,
) => {
  const tasksWithinBudget = pageTasks.slice(0, remaining);
  let consumed = 0;
  for (const task of tasksWithinBudget) {
    consumed += 1;
    const matchesCompleted = task.completed === prepared.completed;
    const matchesAssignee =
      assigneeGid === undefined || task.assignee?.gid === assigneeGid;
    if (matchesCompleted && matchesAssignee) {
      tasks.push(projectTaskListFields(task, prepared.outputFields));
      if (
        prepared.resultCap !== undefined &&
        tasks.length >= prepared.resultCap
      ) {
        break;
      }
    }
  }
  return {
    consumed,
    pageExceedsBudget: pageTasks.length > tasksWithinBudget.length,
    resultCapReached:
      prepared.resultCap !== undefined && tasks.length >= prepared.resultCap,
  };
};

const taskListPaginationError = (
  page: TaskListPage,
  requestedOffsets: ReadonlySet<string>,
): TaskUpdateError | undefined => {
  if (
    page.nextOffset !== undefined &&
    (page.tasks.length === 0 || requestedOffsets.has(page.nextOffset))
  ) {
    return {
      kind: "invalid_response",
      message: "Task pagination did not advance",
    };
  }
  return undefined;
};

const completedTaskListPageResult = (
  tasks: readonly Task[],
  prepared: PreparedTaskListRead,
  scanned: number,
  page: TaskListPage,
  collected: ReturnType<typeof collectMatchingPageTasks>,
): TaskListReadResult | undefined => {
  if (collected.resultCapReached) {
    const stoppedMidPage = collected.consumed < page.tasks.length;
    const truncated =
      scanned >= prepared.scanCap &&
      (stoppedMidPage || page.nextOffset !== undefined);
    return taskListResult(
      tasks,
      scanned,
      truncated,
      stoppedMidPage ? undefined : page.nextOffset,
    );
  }
  if (scanned >= prepared.scanCap) {
    const truncated =
      collected.pageExceedsBudget || page.nextOffset !== undefined;
    return taskListResult(
      tasks,
      scanned,
      truncated,
      collected.pageExceedsBudget ? undefined : page.nextOffset,
    );
  }
  return page.nextOffset === undefined
    ? taskListResult(tasks, scanned, false)
    : undefined;
};

const collectTaskListPages = async (
  token: string,
  prepared: PreparedTaskListRead,
  dependencies: TaskListDependencies,
  source: ResolvedTaskListSource,
  assigneeGid: string | undefined,
): Promise<TaskListReadResult> => {
  const tasks: Task[] = [];
  let scanned = 0;
  let offset = prepared.offset;
  const requestedOffsets = new Set<string>();
  while (scanned < prepared.scanCap) {
    if (offset !== undefined) requestedOffsets.add(offset);
    const remaining = prepared.scanCap - scanned;
    const page = await readTaskListPage(
      token,
      source,
      prepared,
      Math.min(100, remaining),
      offset,
      dependencies.reader,
    );
    if (!page.ok) return page;
    const paginationError = taskListPaginationError(
      page.value,
      requestedOffsets,
    );
    if (paginationError !== undefined) return err(paginationError);
    const { tasks: pageTasks, nextOffset } = page.value;
    const collected = collectMatchingPageTasks(
      pageTasks,
      prepared,
      assigneeGid,
      tasks,
      remaining,
    );
    scanned += collected.consumed;
    const result = completedTaskListPageResult(
      tasks,
      prepared,
      scanned,
      page.value,
      collected,
    );
    if (result !== undefined) return result;
    offset = nextOffset;
  }
  return taskListResult(tasks, scanned, false);
};

export const executeTaskListRead = async (
  token: string,
  prepared: PreparedTaskListRead,
  dependencies: TaskListDependencies,
): Promise<
  Result<
    Readonly<{ tasks: readonly Task[]; meta: TaskListMeta }>,
    TaskUpdateError
  >
> => {
  const source = await resolveTaskListSource(
    token,
    prepared.source,
    dependencies.mySectionResolver,
  );
  if (!source.ok) return source;
  const assignee = await resolveTaskListAssignee(
    token,
    prepared.assigneeFilter,
    dependencies.resolveAuthenticatedUserGid,
  );
  if (!assignee.ok) return assignee;
  return collectTaskListPages(
    token,
    prepared,
    dependencies,
    source.value,
    assignee.value,
  );
};

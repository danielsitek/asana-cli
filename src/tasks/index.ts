import { err, ok, type Result } from "../shared/result.ts";
import { projectFields } from "../utils/project-fields.ts";

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
  Readonly<{ writer: TaskMutationGateway }>;

export type TaskUpdateError =
  | Readonly<{ kind: "invalid_usage"; message: string }>
  | Readonly<{ kind: "internal_error"; message: string }>
  | Readonly<{ kind: "configuration"; message: string }>
  | TaskReadError;

export type MyTasksMutationError = TaskUpdateError;

export type TaskUpdateResult = Readonly<{
  task: Task;
  applied: TaskMutation;
}>;

export type PreparedTaskUpdate = Readonly<{
  taskId: string;
  mutation: TaskMutation;
  notesFile?: string;
  resolveAssigneeMe: boolean;
  mySection?: ResourceSelector;
  customFields: readonly PreparedCustomField[];
  fields?: readonly string[];
}>;

export type TaskCreateOptions = TaskUpdateOptions &
  Readonly<{ parent?: string; project?: string }>;

type TaskCreateConfigError = Readonly<{
  kind: "configuration";
  message: string;
}>;

type TaskCreatePreparationError =
  | Readonly<{ kind: "invalid_usage"; message: string }>
  | TaskCreateConfigError;

type TaskCreateConfig = Readonly<{
  defaultAssignee?: string;
  workspaceGid?: string;
}>;

type TaskCreateConfigResolver = () => Promise<
  Result<TaskCreateConfig, TaskCreateConfigError>
>;

export type PreparedTaskCreate = Readonly<{
  target: TaskCreationTarget;
  mutation: TaskMutation & Readonly<{ name: string }>;
  notesFile?: string;
  resolveAssigneeMe: boolean;
  mySection?: ResourceSelector;
  customFields: readonly PreparedCustomField[];
  fields?: readonly string[];
}>;

type ParsedTaskCreate = Omit<PreparedTaskCreate, "target"> &
  Readonly<{ target?: TaskCreationTarget }>;

const withCreationTarget = (
  prepared: ParsedTaskCreate,
  target: TaskCreationTarget,
): PreparedTaskCreate => ({ ...prepared, target });

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

  const combined = Object.entries(options).some(
    ([key, value]) =>
      key !== "parent" &&
      value !== undefined &&
      (key !== "customFields" || value.length > 0),
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

type PreparedTaskMutation = Omit<PreparedTaskUpdate, "taskId">;

const prepareTaskMutation = (
  options: TaskUpdateOptions,
): Result<
  PreparedTaskMutation,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  const supplied = Object.entries(options).some(
    ([key, value]) =>
      value !== undefined && (key !== "customFields" || value.length > 0),
  );
  if (!supplied) {
    return err({
      kind: "invalid_usage",
      message: "At least one task mutation is required",
    });
  }
  if (options.notes !== undefined && options.notesFile !== undefined) {
    return err({
      kind: "invalid_usage",
      message: "--notes and --notes-file are mutually exclusive",
    });
  }
  if (
    options.assignee !== undefined &&
    options.assignee !== "me" &&
    options.assignee !== "null" &&
    !/^\d+$/.test(options.assignee)
  ) {
    return err({
      kind: "invalid_usage",
      message: "--assignee must be me, null, or a digit-only user GID",
    });
  }

  const mySection =
    options.mySection === undefined
      ? undefined
      : parseResourceSelector(options.mySection, "--my-section");
  if (mySection && !mySection.ok) {
    return err({ kind: "invalid_usage", message: mySection.error });
  }

  const customFields: PreparedCustomField[] = [];
  const seenSelectors = new Set<string>();
  for (const input of options.customFields ?? []) {
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
  if (
    options.dueOn !== undefined &&
    options.dueOn !== "null" &&
    !realDate(options.dueOn)
  ) {
    return err({
      kind: "invalid_usage",
      message: "--due-on must be a real YYYY-MM-DD date or null",
    });
  }
  if (
    options.completed !== undefined &&
    options.completed !== "true" &&
    options.completed !== "false"
  ) {
    return err({
      kind: "invalid_usage",
      message: "--completed must be true or false",
    });
  }

  const mutation: {
    name?: string;
    notes?: string;
    assignee?: string | null;
    due_on?: string | null;
    completed?: boolean;
  } = {};
  if (options.name !== undefined) mutation.name = options.name;
  if (options.notes !== undefined) mutation.notes = options.notes;
  if (options.assignee === "null") {
    mutation.assignee = null;
  } else if (options.assignee !== undefined && options.assignee !== "me") {
    mutation.assignee = options.assignee;
  }
  if (options.dueOn !== undefined) {
    mutation.due_on = options.dueOn === "null" ? null : options.dueOn;
  }
  if (options.completed !== undefined) {
    mutation.completed = options.completed === "true";
  }

  return ok({
    mutation,
    ...(options.notesFile === undefined
      ? {}
      : { notesFile: options.notesFile }),
    resolveAssigneeMe: options.assignee === "me",
    ...(mySection?.ok ? { mySection: mySection.value } : {}),
    customFields,
  });
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
  if (options.parent !== undefined && options.project !== undefined) {
    return err({
      kind: "invalid_usage",
      message: "--parent and --project are mutually exclusive",
    });
  }
  if (options.project !== undefined && options.mySection !== undefined) {
    return err({
      kind: "invalid_usage",
      message: "--project and --my-section are mutually exclusive",
    });
  }
  if (
    options.parent === undefined &&
    options.project === undefined &&
    options.mySection === undefined
  ) {
    return err({
      kind: "invalid_usage",
      message: "One of --parent, --my-section, or --project is required",
    });
  }

  const prepared = prepareTaskMutation(options);
  if (!prepared.ok) return prepared;

  let target: TaskCreationTarget | undefined;
  if (options.parent !== undefined) {
    const parentId = parseTaskId(options.parent);
    if (!parentId.ok) {
      return err({ kind: "invalid_usage", message: parentId.error });
    }
    target = { kind: "subtask", parentId: parentId.value };
  } else if (options.project !== undefined) {
    if (!/^\d+$/.test(options.project)) {
      return err({
        kind: "invalid_usage",
        message: "--project must be a digit-only project GID",
      });
    }
    target = { kind: "project", projectGid: options.project };
  }

  return ok({
    ...(target === undefined ? {} : { target }),
    mutation: {
      ...prepared.value.mutation,
      name: options.name,
    },
    ...(prepared.value.notesFile === undefined
      ? {}
      : { notesFile: prepared.value.notesFile }),
    resolveAssigneeMe: prepared.value.resolveAssigneeMe,
    ...(prepared.value.mySection === undefined
      ? {}
      : { mySection: prepared.value.mySection }),
    customFields: prepared.value.customFields,
    ...(fields.value === undefined ? {} : { fields: fields.value }),
  });
};

const applyDefaultAssignee = (
  prepared: PreparedTaskCreate,
  defaultAssignee: string | undefined,
): PreparedTaskCreate => {
  if (prepared.resolveAssigneeMe || prepared.mutation.assignee !== undefined) {
    return prepared;
  }
  if (defaultAssignee === undefined) return prepared;
  return defaultAssignee === "me"
    ? { ...prepared, resolveAssigneeMe: true }
    : {
        ...prepared,
        mutation: { ...prepared.mutation, assignee: defaultAssignee },
      };
};

const finalizeTaskCreate = (
  prepared: PreparedTaskCreate,
  defaultAssignee?: string,
): Result<
  PreparedTaskCreate,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  const effective = applyDefaultAssignee(prepared, defaultAssignee);
  const hasMyTasksMutation =
    effective.mySection !== undefined || effective.customFields.length > 0;
  const hasAssignableUser =
    effective.resolveAssigneeMe ||
    (effective.mutation.assignee !== undefined &&
      effective.mutation.assignee !== null);
  if (hasMyTasksMutation && !hasAssignableUser) {
    return err({
      kind: "invalid_usage",
      message:
        "My Tasks values on a new task require --assignee=me or a user GID",
    });
  }
  return ok(effective);
};

export const prepareTaskCreate = (
  options: TaskCreateOptions,
  fieldsInput?: string,
): Result<PreparedTaskCreate, TaskCreatePreparationError> => {
  const prepared = parseTaskCreateInput(options, fieldsInput);
  if (!prepared.ok) return prepared;
  if (prepared.value.target === undefined) {
    return err({
      kind: "configuration",
      message: "workspace.gid is required to create a task in My Tasks",
    });
  }
  return finalizeTaskCreate(
    withCreationTarget(prepared.value, prepared.value.target),
  );
};

export const prepareTaskCreateWithConfig = async (
  options: TaskCreateOptions,
  resolveConfig?: TaskCreateConfigResolver,
  fieldsInput?: string,
): Promise<Result<PreparedTaskCreate, TaskCreatePreparationError>> => {
  const prepared = parseTaskCreateInput(options, fieldsInput);
  if (!prepared.ok) return prepared;
  const needsDefaultAssignee = options.assignee === undefined;
  if (
    prepared.value.target !== undefined &&
    (!needsDefaultAssignee || !resolveConfig)
  ) {
    return finalizeTaskCreate(
      withCreationTarget(prepared.value, prepared.value.target),
    );
  }

  const resolved = resolveConfig
    ? await resolveConfig()
    : ok<TaskCreateConfig>({});
  if (!resolved.ok) return resolved;
  const { defaultAssignee, workspaceGid } = resolved.value;
  if (
    defaultAssignee !== undefined &&
    defaultAssignee !== "me" &&
    !/^\d+$/.test(defaultAssignee)
  ) {
    return err({
      kind: "configuration",
      message: "defaultAssignee must be me or a digit-only user GID",
    });
  }
  let target = prepared.value.target;
  if (target === undefined) {
    if (workspaceGid === undefined || !/^\d+$/.test(workspaceGid)) {
      return err({
        kind: "configuration",
        message: "workspace.gid is required to create a task in My Tasks",
      });
    }
    target = { kind: "workspace", workspaceGid };
  }
  const withTarget = withCreationTarget(prepared.value, target);
  return finalizeTaskCreate(withTarget, defaultAssignee);
};

const publicTaskError = (
  error: TaskReadError,
): NonNullable<TaskCreationStage["error"]> => {
  const messages: Readonly<Record<TaskReadError["kind"], string>> = {
    authentication: "Asana authentication failed",
    api: "Asana API request failed",
    not_found: "Task not found",
    rate_limit: "Asana request retries exhausted",
    network: "Unable to reach Asana",
    invalid_response: "Asana returned an invalid response",
  };
  return { kind: error.kind, message: messages[error.kind] };
};

type PreparedTaskMaterialization = Readonly<{
  taskId?: string;
  mutation: TaskMutation;
  notesFile?: string;
  resolveAssigneeMe: boolean;
  mySection?: ResourceSelector;
  customFields: readonly PreparedCustomField[];
  workflow: "update" | "creation";
}>;

const materializeTaskMutation = async (
  token: string,
  prepared: PreparedTaskMaterialization,
  dependencies: TaskMaterializationDependencies,
): Promise<Result<TaskMutation, TaskUpdateError>> => {
  const mutation = { ...prepared.mutation };
  if (prepared.notesFile !== undefined) {
    try {
      mutation.notes =
        prepared.notesFile === "-"
          ? await dependencies.readStdin()
          : await dependencies.readFile(prepared.notesFile);
    } catch {
      return err({
        kind: "invalid_usage",
        message:
          prepared.notesFile === "-"
            ? "Unable to read notes from stdin"
            : "Unable to read notes file",
      });
    }
  }

  let authenticatedUserGid: string | undefined;
  if (prepared.resolveAssigneeMe) {
    const identity = await dependencies.resolveAuthenticatedUserGid(token);
    if (!identity.ok) return identity;
    mutation.assignee = identity.value;
    authenticatedUserGid = identity.value;
  }

  const hasMyTasksMutation =
    prepared.mySection !== undefined || prepared.customFields.length > 0;
  if (!hasMyTasksMutation) return ok(mutation);
  if (!dependencies.myTasksMutationResolver) {
    return err({
      kind: "internal_error",
      message: `My Tasks ${prepared.workflow} dependencies are unavailable`,
    });
  }

  const resolved = await dependencies.myTasksMutationResolver.resolve({
    token,
    ...(prepared.taskId === undefined ? {} : { taskId: prepared.taskId }),
    ...(mutation.assignee === undefined
      ? {}
      : { finalAssignee: mutation.assignee }),
    ...(authenticatedUserGid === undefined ? {} : { authenticatedUserGid }),
    ...(prepared.mySection === undefined
      ? {}
      : { mySection: prepared.mySection }),
    customFields: prepared.customFields,
  });
  if (!resolved.ok) return resolved;
  Object.assign(mutation, resolved.value);
  return ok(mutation);
};

export const executeTaskCreation = async (
  token: string,
  prepared: PreparedTaskCreate,
  dependencies: TaskCreationDependencies,
): Promise<Result<TaskCreationResult, TaskUpdateError>> => {
  const materialized = await materializeTaskMutation(
    token,
    { ...prepared, workflow: "creation" },
    dependencies,
  );
  if (!materialized.ok) return materialized;
  const mutation = materialized.value;

  const assignee = mutation.assignee;
  const createMutation = orderMutation({
    name: prepared.mutation.name,
    ...(mutation.notes === undefined ? {} : { notes: mutation.notes }),
    ...(mutation.due_on === undefined ? {} : { due_on: mutation.due_on }),
    ...(mutation.completed === undefined
      ? {}
      : { completed: mutation.completed }),
  });
  const requestedStages: ReadonlyArray<
    readonly [TaskCreationStageName, TaskMutation | undefined]
  > = [
    ["assignee", assignee === undefined ? undefined : { assignee }],
    [
      "my_section",
      mutation.assignee_section === undefined
        ? undefined
        : { assignee_section: mutation.assignee_section },
    ],
    [
      "custom_fields",
      mutation.custom_fields === undefined
        ? undefined
        : { custom_fields: mutation.custom_fields },
    ],
  ];
  const hasStagedWrites = requestedStages.some(
    ([, applied]) => applied !== undefined,
  );
  if (hasStagedWrites && dependencies.writer === undefined) {
    return err({
      kind: "internal_error",
      message: "Task writer is required for staged task mutations",
    });
  }

  const created = await dependencies.creator.createTask(
    token,
    prepared.target,
    createMutation,
    prepared.fields,
  );
  if (!created.ok) return created;

  let task: Task = created.value;
  const taskId = created.value.gid;
  const stages: TaskCreationStage[] = [
    { stage: "create", status: "completed", applied: createMutation },
  ];
  const writer = dependencies.writer;
  if (writer === undefined) {
    for (const [stage] of requestedStages) {
      stages.push({ stage, status: "not_run", reason: "not_requested" });
    }
    return ok({ task, stages, complete: true });
  }
  let stopped = false;
  for (const [stage, applied] of requestedStages) {
    if (applied === undefined) {
      stages.push({ stage, status: "not_run", reason: "not_requested" });
      continue;
    }
    if (stopped) {
      stages.push({
        stage,
        status: "not_run",
        reason: "stopped_after_failure",
      });
      continue;
    }
    const updated = await writer.updateTask(
      token,
      taskId,
      applied,
      prepared.fields,
    );
    if (!updated.ok) {
      stages.push({
        stage,
        status: "failed",
        applied,
        error: publicTaskError(updated.error),
      });
      stopped = true;
      continue;
    }
    task = updated.value;
    stages.push({ stage, status: "completed", applied });
  }
  return ok({ task, stages, complete: !stopped });
};

export const executeTaskUpdate = async (
  token: string,
  prepared: PreparedTaskUpdate,
  dependencies: TaskUpdateDependencies,
): Promise<Result<TaskUpdateResult, TaskUpdateError>> => {
  const materialized = await materializeTaskMutation(
    token,
    { ...prepared, workflow: "update" },
    dependencies,
  );
  if (!materialized.ok) return materialized;
  const applied = orderMutation(materialized.value);
  const updated = await dependencies.writer.updateTask(
    token,
    prepared.taskId,
    applied,
    prepared.fields,
  );
  return updated.ok ? ok({ task: updated.value, applied }) : updated;
};

const orderMutation = (mutation: TaskMutation): TaskMutation => ({
  ...(mutation.name === undefined ? {} : { name: mutation.name }),
  ...(mutation.notes === undefined ? {} : { notes: mutation.notes }),
  ...(mutation.assignee === undefined ? {} : { assignee: mutation.assignee }),
  ...(mutation.due_on === undefined ? {} : { due_on: mutation.due_on }),
  ...(mutation.completed === undefined
    ? {}
    : { completed: mutation.completed }),
  ...(mutation.assignee_section === undefined
    ? {}
    : { assignee_section: mutation.assignee_section }),
  ...(mutation.custom_fields === undefined
    ? {}
    : { custom_fields: mutation.custom_fields }),
});

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
  | { kind: "my_section"; selector: ResourceSelector }
>;

export type TaskListOptions = Readonly<{
  mySection?: string;
  section?: string;
  project?: string;
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

export const prepareTaskListRead = (
  options: TaskListOptions,
  fieldsInput?: string,
): Result<
  PreparedTaskListRead,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  const sourcesSupplied = [
    options.mySection,
    options.section,
    options.project,
  ].filter((value) => value !== undefined).length;
  if (sourcesSupplied !== 1) {
    return err({
      kind: "invalid_usage",
      message:
        "Exactly one of --my-section, --section, or --project is required",
    });
  }

  let source: TaskListSource;
  if (options.mySection !== undefined) {
    if (!options.mySection.startsWith("@") || options.mySection.length <= 1) {
      return err({
        kind: "invalid_usage",
        message: "--my-section must use an @alias",
      });
    }
    source = {
      kind: "my_section",
      selector: { kind: "alias", value: options.mySection.slice(1) },
    };
  } else if (options.section !== undefined) {
    if (!/^\d+$/.test(options.section)) {
      return err({
        kind: "invalid_usage",
        message: "--section must be a digit-only GID",
      });
    }
    source = { kind: "section", sectionGid: options.section };
  } else {
    const project = options.project as string;
    if (!/^\d+$/.test(project)) {
      return err({
        kind: "invalid_usage",
        message: "--project must be a digit-only GID",
      });
    }
    source = { kind: "project", projectGid: project };
  }

  let assigneeFilter: TaskListAssigneeFilter | undefined;
  if (options.assignee !== undefined) {
    if (options.assignee === "me") {
      assigneeFilter = { kind: "me" };
    } else if (/^\d+$/.test(options.assignee)) {
      assigneeFilter = { kind: "gid", value: options.assignee };
    } else {
      return err({
        kind: "invalid_usage",
        message: "--assignee must be me or a digit-only user GID",
      });
    }
  }

  let completed = false;
  if (options.completed !== undefined) {
    if (options.completed !== "true" && options.completed !== "false") {
      return err({
        kind: "invalid_usage",
        message: "--completed must be true or false",
      });
    }
    completed = options.completed === "true";
  }

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
    assigneeFilter !== undefined,
  );

  return ok({
    source,
    ...(assigneeFilter === undefined ? {} : { assigneeFilter }),
    completed,
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
  let sectionGid: string | undefined;
  let projectGid: string | undefined;
  if (prepared.source.kind === "section") {
    sectionGid = prepared.source.sectionGid;
  } else if (prepared.source.kind === "project") {
    projectGid = prepared.source.projectGid;
  } else {
    if (!dependencies.mySectionResolver) {
      return err({
        kind: "internal_error",
        message: "My Tasks section resolution dependencies are unavailable",
      });
    }
    const resolved = await dependencies.mySectionResolver.resolve(
      token,
      prepared.source.selector,
    );
    if (!resolved.ok) return resolved;
    sectionGid = resolved.value.sectionGid;
  }

  let assigneeGid: string | undefined;
  if (prepared.assigneeFilter?.kind === "me") {
    const identity = await dependencies.resolveAuthenticatedUserGid(token);
    if (!identity.ok) return identity;
    assigneeGid = identity.value;
  } else if (prepared.assigneeFilter?.kind === "gid") {
    assigneeGid = prepared.assigneeFilter.value;
  }

  const completedSince = prepared.completed ? EPOCH_COMPLETED_SINCE : "now";

  const tasks: Task[] = [];
  let scanned = 0;
  let offset = prepared.offset;
  const requestedOffsets = new Set<string>();

  while (scanned < prepared.scanCap) {
    if (offset !== undefined) requestedOffsets.add(offset);
    const remaining = prepared.scanCap - scanned;
    const pageOptions = {
      fields: prepared.requestFields,
      limit: Math.min(100, remaining),
      completedSince,
      ...(offset === undefined ? {} : { offset }),
    };
    const page =
      sectionGid !== undefined
        ? await dependencies.reader.getSectionTasks(
            token,
            sectionGid,
            pageOptions,
          )
        : await dependencies.reader.getProjectTasks(
            token,
            projectGid as string,
            pageOptions,
          );
    if (!page.ok) return page;

    const { tasks: pageTasks, nextOffset } = page.value;
    if (
      nextOffset !== undefined &&
      (pageTasks.length === 0 || requestedOffsets.has(nextOffset))
    ) {
      return err({
        kind: "invalid_response",
        message: "Task pagination did not advance",
      });
    }
    const tasksWithinBudget = pageTasks.slice(0, remaining);
    const pageExceedsBudget = pageTasks.length > tasksWithinBudget.length;
    for (let index = 0; index < tasksWithinBudget.length; index += 1) {
      const task = tasksWithinBudget[index]!;
      scanned += 1;
      const matchesCompleted = task.completed === prepared.completed;
      const matchesAssignee =
        assigneeGid === undefined || task.assignee?.gid === assigneeGid;
      if (matchesCompleted && matchesAssignee) {
        tasks.push(projectTaskListFields(task, prepared.outputFields));
        if (
          prepared.resultCap !== undefined &&
          tasks.length >= prepared.resultCap
        ) {
          const stoppedMidPage = index < pageTasks.length - 1;
          const scanCapReached = scanned >= prepared.scanCap;
          const scanTruncated =
            scanCapReached && (stoppedMidPage || nextOffset !== undefined);
          return ok({
            tasks,
            meta: {
              scanned,
              returned: tasks.length,
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
        tasks,
        meta: {
          scanned,
          returned: tasks.length,
          scan_truncated: pageExceedsBudget || nextOffset !== undefined,
          ...(pageExceedsBudget || nextOffset === undefined
            ? {}
            : { next_offset: nextOffset }),
        },
      });
    }

    if (nextOffset === undefined) {
      return ok({
        tasks,
        meta: { scanned, returned: tasks.length, scan_truncated: false },
      });
    }
    offset = nextOffset;
  }

  return ok({
    tasks,
    meta: { scanned, returned: tasks.length, scan_truncated: false },
  });
};

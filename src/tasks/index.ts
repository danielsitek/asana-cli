import { err, ok, type Result } from "../shared/result.ts";
import type {
  ConfigError,
  DiscoveryError,
  DiscoveredMyTasks,
  MyTasksDiscoveryGateway,
  ResolvedConfig,
} from "../config/index.ts";

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
  custom_fields?: Readonly<Record<string, number | null>>;
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
  ): Promise<Result<Task, TaskReadError>>;
}

export type TaskUpdateDependencies = Readonly<{
  writer: TaskMutationGateway;
  reader?: TaskGateway;
  discovery?: MyTasksDiscoveryGateway;
  resolveConfiguration?: () => Promise<Result<ResolvedConfig, ConfigError>>;
  resolveAuthenticatedUserGid: (
    token: string,
  ) => Promise<Result<string, TaskReadError>>;
  readFile: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
}>;

export type TaskUpdateError =
  | Readonly<{ kind: "invalid_usage"; message: string }>
  | Readonly<{ kind: "internal_error"; message: string }>
  | ConfigError
  | DiscoveryError
  | TaskReadError;

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
}>;

export type ResourceSelector = Readonly<
  { kind: "gid"; value: string } | { kind: "alias"; value: string }
>;

export type PreparedCustomField = Readonly<{
  field: ResourceSelector;
  value: number | null;
}>;

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

const parseNumberValue = (input: string): Result<number | null, string> => {
  if (input === "null") return ok(null);
  if (!/^-?\d+(?:\.\d+)?$/.test(input)) {
    return err("Custom field value must be an integer, dot-decimal, or null");
  }
  const value = Number(input);
  return Number.isFinite(value)
    ? ok(value)
    : err("Custom field value must be finite");
};

const parseCustomField = (
  input: string,
): Result<PreparedCustomField, string> => {
  const delimiter = input.indexOf(":");
  if (delimiter <= 0 || delimiter !== input.lastIndexOf(":")) {
    return err("--custom-field must use <field-gid|@alias>:<value>");
  }
  const field = parseResourceSelector(
    input.slice(0, delimiter),
    "--custom-field",
  );
  if (!field.ok) return field;
  const value = parseNumberValue(input.slice(delimiter + 1));
  if (!value.ok) return value;
  return ok({ field: field.value, value: value.value });
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

export const prepareTaskUpdate = (
  taskIdInput: string,
  options: TaskUpdateOptions,
): Result<
  PreparedTaskUpdate,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  const taskId = parseTaskId(taskIdInput);
  if (!taskId.ok) return err({ kind: "invalid_usage", message: taskId.error });

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
    taskId: taskId.value,
    mutation,
    ...(options.notesFile === undefined
      ? {}
      : { notesFile: options.notesFile }),
    resolveAssigneeMe: options.assignee === "me",
    ...(mySection?.ok ? { mySection: mySection.value } : {}),
    customFields,
  });
};

export const executeTaskUpdate = async (
  token: string,
  prepared: PreparedTaskUpdate,
  dependencies: TaskUpdateDependencies,
): Promise<Result<TaskUpdateResult, TaskUpdateError>> => {
  const mutation = { ...prepared.mutation };
  let authenticatedUserGid: string | undefined;
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
  if (prepared.resolveAssigneeMe) {
    const identity = await dependencies.resolveAuthenticatedUserGid(token);
    if (!identity.ok) return identity;
    mutation.assignee = identity.value;
    authenticatedUserGid = identity.value;
  }

  const hasMyTasksMutation =
    prepared.mySection !== undefined || prepared.customFields.length > 0;
  if (hasMyTasksMutation) {
    const preparedMyTasks = await prepareMyTasksMutation(
      token,
      prepared,
      mutation,
      authenticatedUserGid,
      dependencies,
    );
    if (!preparedMyTasks.ok) return preparedMyTasks;
    Object.assign(mutation, preparedMyTasks.value);
  }

  const applied = orderMutation(mutation);
  const updated = await dependencies.writer.updateTask(
    token,
    prepared.taskId,
    applied,
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

const configurationError = (message: string): ConfigError => ({
  kind: "configuration",
  message,
});

const resolveAlias = (
  selector: ResourceSelector,
  aliases: Readonly<Record<string, string>> | undefined,
  resource: string,
): Result<string, ConfigError> => {
  if (selector.kind === "gid") return ok(selector.value);
  const gid = aliases?.[selector.value];
  return gid
    ? ok(gid)
    : err(
        configurationError(
          `${resource} alias @${selector.value} is not configured`,
        ),
      );
};

const requireMyTasksDependencies = (
  dependencies: TaskUpdateDependencies,
): Result<
  Readonly<{
    reader: TaskGateway;
    discovery: MyTasksDiscoveryGateway;
    resolveConfiguration: () => Promise<Result<ResolvedConfig, ConfigError>>;
  }>,
  Readonly<{ kind: "internal_error"; message: string }>
> => {
  if (
    !dependencies.reader ||
    !dependencies.discovery ||
    !dependencies.resolveConfiguration
  ) {
    return err({
      kind: "internal_error",
      message: "My Tasks update dependencies are unavailable",
    });
  }
  return ok({
    reader: dependencies.reader,
    discovery: dependencies.discovery,
    resolveConfiguration: dependencies.resolveConfiguration,
  });
};

const validateDiscoveredResources = (
  discovered: DiscoveredMyTasks,
  configuredUserTaskListGid: string,
  sectionGid: string | undefined,
  customFieldGids: readonly string[],
): Result<void, ConfigError> => {
  if (discovered.userTaskListGid !== configuredUserTaskListGid) {
    return err(
      configurationError(
        "Configured My Tasks list does not match the authenticated user's list",
      ),
    );
  }
  if (
    sectionGid !== undefined &&
    !discovered.sections.some((section) => section.gid === sectionGid)
  ) {
    return err(
      configurationError(
        `My Tasks section ${sectionGid} is not present in the configured list`,
      ),
    );
  }
  for (const gid of customFieldGids) {
    const field = discovered.customFields.find(
      (candidate) => candidate.gid === gid,
    );
    if (!field) {
      return err(
        configurationError(
          `Custom field ${gid} is not present in the configured My Tasks list`,
        ),
      );
    }
    if (field.resourceSubtype !== "number") {
      return err(
        configurationError(`Custom field ${gid} is not a number field`),
      );
    }
    if (field.isReadOnly) {
      return err(configurationError(`Custom field ${gid} is read-only`));
    }
  }
  return ok(undefined);
};

const prepareMyTasksMutation = async (
  token: string,
  prepared: PreparedTaskUpdate,
  mutation: TaskMutation,
  knownAuthenticatedUserGid: string | undefined,
  dependencies: TaskUpdateDependencies,
): Promise<
  Result<
    Readonly<{
      assignee_section?: string;
      custom_fields?: Readonly<Record<string, number | null>>;
    }>,
    TaskUpdateError
  >
> => {
  const required = requireMyTasksDependencies(dependencies);
  if (!required.ok) return required;

  const resolved = await required.value.resolveConfiguration();
  if (!resolved.ok) return resolved;
  const workspaceGid = resolved.value.value.workspace?.gid;
  const configuredMyTasks = resolved.value.value.myTasks;
  if (!workspaceGid) {
    return err(
      configurationError("workspace.gid is required in configuration"),
    );
  }
  if (!configuredMyTasks?.userTaskListGid) {
    return err(
      configurationError(
        "myTasks.userTaskListGid is required in local configuration",
      ),
    );
  }

  const sectionGid = prepared.mySection
    ? resolveAlias(
        prepared.mySection,
        configuredMyTasks.sections,
        "My Tasks section",
      )
    : ok(undefined);
  if (!sectionGid.ok) return sectionGid;

  const customFields: Record<string, number | null> = {};
  for (const customField of prepared.customFields) {
    const gid = resolveAlias(
      customField.field,
      configuredMyTasks.customFields,
      "Custom field",
    );
    if (!gid.ok) return gid;
    if (Object.hasOwn(customFields, gid.value)) {
      return err({
        kind: "invalid_usage",
        message: "--custom-field cannot update the same field more than once",
      });
    }
    customFields[gid.value] = customField.value;
  }

  const discovered = await required.value.discovery.discoverMyTasks(
    token,
    workspaceGid,
  );
  if (!discovered.ok) return discovered;
  const validated = validateDiscoveredResources(
    discovered.value,
    configuredMyTasks.userTaskListGid,
    sectionGid.value,
    Object.keys(customFields),
  );
  if (!validated.ok) return validated;

  const identity = knownAuthenticatedUserGid
    ? ok(knownAuthenticatedUserGid)
    : await dependencies.resolveAuthenticatedUserGid(token);
  if (!identity.ok) return identity;
  let finalAssignee = mutation.assignee;
  if (finalAssignee === undefined) {
    const current = await required.value.reader.getTask(
      token,
      prepared.taskId,
      ["assignee.gid"],
    );
    if (!current.ok) return current;
    finalAssignee = current.value.assignee?.gid;
  }
  if (finalAssignee !== identity.value) {
    return err({
      kind: "invalid_usage",
      message:
        "My Tasks mutations require the final assignee to be the authenticated user",
    });
  }

  const sortedCustomFields = Object.fromEntries(
    Object.entries(customFields).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  return ok({
    ...(sectionGid.value === undefined
      ? {}
      : { assignee_section: sectionGid.value }),
    ...(Object.keys(sortedCustomFields).length === 0
      ? {}
      : { custom_fields: sortedCustomFields }),
  });
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

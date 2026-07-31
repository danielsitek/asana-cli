import { err, ok, type Result } from "../shared/result.ts";

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
  resolveAuthenticatedUserGid: (
    token: string,
  ) => Promise<Result<string, TaskReadError>>;
  readFile: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
}>;

export type TaskUpdateError =
  | Readonly<{ kind: "invalid_usage"; message: string }>
  | TaskReadError;

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

  const supplied = Object.values(options).some((value) => value !== undefined);
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
): Promise<Result<Task, TaskUpdateError>> => {
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
  if (prepared.resolveAssigneeMe) {
    const identity = await dependencies.resolveAuthenticatedUserGid(token);
    if (!identity.ok) return identity;
    mutation.assignee = identity.value;
  }
  return dependencies.writer.updateTask(token, prepared.taskId, mutation);
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

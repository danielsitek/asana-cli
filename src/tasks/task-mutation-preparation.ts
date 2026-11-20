import { err, ok, type Result } from "../shared/result.ts";
import type {
  PreparedCustomField,
  PreparedTaskCreate,
  PreparedTaskParentUpdate,
  PreparedTaskUpdate,
  ResourceSelector,
  TaskCreationTarget,
  TaskCreateOptions,
  TaskMutation,
  TaskParentUpdateOptions,
  TaskUpdateOptions,
} from "./index.ts";
import { parseTaskId, prepareSelectedFields } from "./task-input.ts";
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

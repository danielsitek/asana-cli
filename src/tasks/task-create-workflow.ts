import { err, ok, type Result } from "../shared/result.ts";
import type {
  PreparedCustomField,
  PreparedTaskCreate,
  PreparedTaskUpdate,
  ResourceSelector,
  TaskCreateOptions,
  TaskCreationTarget,
  TaskMutation,
} from "./index.ts";

type InvalidTaskCreateUsage = Readonly<{
  kind: "invalid_usage";
  message: string;
}>;

type TaskCreateConfigError = Readonly<{
  kind: "configuration";
  message: string;
}>;

export type TaskCreatePreparationError =
  | InvalidTaskCreateUsage
  | TaskCreateConfigError;

type TaskCreateConfig = Readonly<{
  defaultAssignee?: string;
  workspaceGid?: string;
}>;

export type TaskCreateConfigResolver = () => Promise<
  Result<TaskCreateConfig, TaskCreateConfigError>
>;

export type PreparedTaskMutation = Omit<PreparedTaskUpdate, "taskId">;

export type ParsedTaskCreate = Readonly<{
  target?: TaskCreationTarget;
  mutation: TaskMutation & Readonly<{ name: string }>;
  notesFile?: string;
  resolveAssigneeMe: boolean;
  mySection?: ResourceSelector;
  customFields: readonly PreparedCustomField[];
  fields?: readonly string[];
}>;

const hasParentProjectConflict = (options: TaskCreateOptions): boolean =>
  options.parent !== undefined && options.project !== undefined;

const hasProjectMySectionConflict = (options: TaskCreateOptions): boolean =>
  options.project !== undefined && options.mySection !== undefined;

const hasSectionTargetConflict = (options: TaskCreateOptions): boolean =>
  options.section !== undefined &&
  [options.parent, options.project, options.mySection].some(
    (value) => value !== undefined,
  );

const hasCreationTarget = (options: TaskCreateOptions): boolean =>
  [options.parent, options.project, options.mySection, options.section].some(
    (value) => value !== undefined,
  );

export const validateTaskCreationTarget = (
  options: TaskCreateOptions,
): Result<void, InvalidTaskCreateUsage> => {
  if (hasParentProjectConflict(options)) {
    return err({
      kind: "invalid_usage",
      message: "--parent and --project are mutually exclusive",
    });
  }
  if (hasProjectMySectionConflict(options)) {
    return err({
      kind: "invalid_usage",
      message: "--project and --my-section are mutually exclusive",
    });
  }
  if (hasSectionTargetConflict(options)) {
    return err({
      kind: "invalid_usage",
      message:
        "--section cannot be combined with --parent, --project, or --my-section",
    });
  }
  return hasCreationTarget(options)
    ? ok(undefined)
    : err({
        kind: "invalid_usage",
        message:
          "One of --parent, --my-section, --section, or --project is required",
      });
};

export const assembleParsedTaskCreate = (
  name: string,
  prepared: PreparedTaskMutation,
  target: TaskCreationTarget | undefined,
  fields: readonly string[] | undefined,
): ParsedTaskCreate => ({
  ...(target === undefined ? {} : { target }),
  mutation: { ...prepared.mutation, name },
  ...(prepared.notesFile === undefined
    ? {}
    : { notesFile: prepared.notesFile }),
  resolveAssigneeMe: prepared.resolveAssigneeMe,
  ...(prepared.mySection === undefined
    ? {}
    : { mySection: prepared.mySection }),
  customFields: prepared.customFields,
  ...(fields === undefined ? {} : { fields }),
});

const withCreationTarget = (
  prepared: ParsedTaskCreate,
  target: TaskCreationTarget,
): PreparedTaskCreate => ({ ...prepared, target });

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
): Result<PreparedTaskCreate, InvalidTaskCreateUsage> => {
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

export const finalizeExplicitTaskCreate = (
  prepared: ParsedTaskCreate,
): Result<PreparedTaskCreate, TaskCreatePreparationError> => {
  if (prepared.target === undefined) {
    return err({
      kind: "configuration",
      message: "workspace.gid is required to create a task in My Tasks",
    });
  }
  return finalizeTaskCreate(withCreationTarget(prepared, prepared.target));
};

const validateDefaultAssignee = (
  defaultAssignee: string | undefined,
): Result<void, TaskCreateConfigError> =>
  defaultAssignee === undefined ||
  defaultAssignee === "me" ||
  /^\d+$/.test(defaultAssignee)
    ? ok(undefined)
    : err({
        kind: "configuration",
        message: "defaultAssignee must be me or a digit-only user GID",
      });

const resolveCreationTarget = (
  target: TaskCreationTarget | undefined,
  workspaceGid: string | undefined,
): Result<TaskCreationTarget, TaskCreateConfigError> => {
  if (target !== undefined) return ok(target);
  return workspaceGid !== undefined && /^\d+$/.test(workspaceGid)
    ? ok({ kind: "workspace", workspaceGid })
    : err({
        kind: "configuration",
        message: "workspace.gid is required to create a task in My Tasks",
      });
};

export const prepareConfiguredTaskCreate = async (
  options: TaskCreateOptions,
  prepared: ParsedTaskCreate,
  resolveConfig?: TaskCreateConfigResolver,
): Promise<Result<PreparedTaskCreate, TaskCreatePreparationError>> => {
  const needsDefaultAssignee = options.assignee === undefined;
  if (
    prepared.target !== undefined &&
    (!needsDefaultAssignee || !resolveConfig)
  ) {
    return finalizeTaskCreate(withCreationTarget(prepared, prepared.target));
  }

  const resolved = resolveConfig
    ? await resolveConfig()
    : ok<TaskCreateConfig>({});
  if (!resolved.ok) return resolved;
  const { defaultAssignee, workspaceGid } = resolved.value;
  const validDefault = validateDefaultAssignee(defaultAssignee);
  if (!validDefault.ok) return validDefault;
  const target = resolveCreationTarget(prepared.target, workspaceGid);
  if (!target.ok) return target;
  return finalizeTaskCreate(
    withCreationTarget(prepared, target.value),
    defaultAssignee,
  );
};

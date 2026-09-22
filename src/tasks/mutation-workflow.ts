import { err, ok, type Result } from "../shared/result.ts";
import type {
  PreparedCustomField,
  PreparedTaskCreate,
  PreparedTaskUpdate,
  ResourceSelector,
  Task,
  TaskCreationDependencies,
  TaskCreationResult,
  TaskCreationStage,
  TaskCreationStageName,
  TaskMutation,
  TaskMutationGateway,
  TaskProjectMutationGateway,
  TaskReadError,
  TaskSectionMutationGateway,
  TaskUpdateDependencies,
  TaskUpdateError,
  TaskUpdateResult,
} from "./index.ts";

type TaskMaterializationDependencies = Pick<
  TaskUpdateDependencies,
  | "myTasksMutationResolver"
  | "resolveAuthenticatedUserGid"
  | "readFile"
  | "readStdin"
>;

type PreparedTaskMaterialization = Readonly<{
  taskId?: string;
  mutation: TaskMutation;
  notesFile?: string;
  resolveAssigneeMe: boolean;
  mySection?: ResourceSelector;
  customFields: readonly PreparedCustomField[];
  workflow: "update" | "creation";
}>;

type MaterializedAssignee = Readonly<{
  assignee: TaskMutation["assignee"];
  authenticatedUserGid?: string;
}>;

const materializeNotes = async (
  prepared: PreparedTaskMaterialization,
  dependencies: TaskMaterializationDependencies,
): Promise<Result<string | undefined, TaskUpdateError>> => {
  if (prepared.notesFile === undefined) return ok(prepared.mutation.notes);
  try {
    return ok(
      prepared.notesFile === "-"
        ? await dependencies.readStdin()
        : await dependencies.readFile(prepared.notesFile),
    );
  } catch {
    return err({
      kind: "invalid_usage",
      message:
        prepared.notesFile === "-"
          ? "Unable to read notes from stdin"
          : "Unable to read notes file",
    });
  }
};

const materializeAssignee = async (
  token: string,
  prepared: PreparedTaskMaterialization,
  dependencies: TaskMaterializationDependencies,
): Promise<Result<MaterializedAssignee, TaskUpdateError>> => {
  if (!prepared.resolveAssigneeMe) {
    return ok({ assignee: prepared.mutation.assignee });
  }
  const identity = await dependencies.resolveAuthenticatedUserGid(token);
  return identity.ok
    ? ok({ assignee: identity.value, authenticatedUserGid: identity.value })
    : identity;
};

const materializeTaskMutation = async (
  token: string,
  prepared: PreparedTaskMaterialization,
  dependencies: TaskMaterializationDependencies,
): Promise<Result<TaskMutation, TaskUpdateError>> => {
  const notes = await materializeNotes(prepared, dependencies);
  if (!notes.ok) return notes;
  const assignee = await materializeAssignee(token, prepared, dependencies);
  if (!assignee.ok) return assignee;
  const mutation: TaskMutation = {
    ...prepared.mutation,
    ...(notes.value === undefined ? {} : { notes: notes.value }),
    ...(assignee.value.assignee === undefined
      ? {}
      : { assignee: assignee.value.assignee }),
  };

  const hasMyTasksMutation =
    prepared.mySection !== undefined || prepared.customFields.length > 0;
  if (!hasMyTasksMutation) return ok(mutation);
  const resolver = dependencies.myTasksMutationResolver;
  if (!resolver) {
    return err({
      kind: "internal_error",
      message: `My Tasks ${prepared.workflow} dependencies are unavailable`,
    });
  }

  const resolved = await resolver.resolve({
    token,
    ...(prepared.taskId === undefined ? {} : { taskId: prepared.taskId }),
    ...(mutation.assignee === undefined
      ? {}
      : { finalAssignee: mutation.assignee }),
    ...(assignee.value.authenticatedUserGid === undefined
      ? {}
      : { authenticatedUserGid: assignee.value.authenticatedUserGid }),
    ...(prepared.mySection === undefined
      ? {}
      : { mySection: prepared.mySection }),
    customFields: prepared.customFields,
  });
  return resolved.ok ? ok({ ...mutation, ...resolved.value }) : resolved;
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

type RequestedCreationStage = readonly [
  TaskCreationStageName,
  TaskMutation | undefined,
];

const buildCreationMutation = (
  name: string,
  mutation: TaskMutation,
): TaskMutation =>
  orderMutation({
    name,
    ...(mutation.notes === undefined ? {} : { notes: mutation.notes }),
    ...(mutation.due_on === undefined ? {} : { due_on: mutation.due_on }),
    ...(mutation.completed === undefined
      ? {}
      : { completed: mutation.completed }),
  });

const buildRequestedCreationStages = (
  mutation: TaskMutation,
): readonly RequestedCreationStage[] => [
  [
    "assignee",
    mutation.assignee === undefined
      ? undefined
      : { assignee: mutation.assignee },
  ],
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

const validateCreationWriter = (
  requestedStages: readonly RequestedCreationStage[],
  writer: TaskMutationGateway | undefined,
): Result<void, TaskUpdateError> =>
  writer === undefined &&
  requestedStages.some(([, applied]) => applied !== undefined)
    ? err({
        kind: "internal_error",
        message: "Task writer is required for staged task mutations",
      })
    : ok(undefined);

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

const applyCreationStages = async (
  token: string,
  taskId: string,
  initialTask: Task,
  requestedStages: readonly RequestedCreationStage[],
  writer: TaskMutationGateway,
  fields: readonly string[] | undefined,
): Promise<TaskCreationResult> => {
  let task = initialTask;
  let stopped = false;
  const stages: TaskCreationStage[] = [];
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
    const updated = await writer.updateTask(token, taskId, applied, fields);
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
  return { task, stages, complete: !stopped };
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
  const createMutation = buildCreationMutation(
    prepared.mutation.name,
    materialized.value,
  );
  const requestedStages = buildRequestedCreationStages(materialized.value);
  const validWriter = validateCreationWriter(
    requestedStages,
    dependencies.writer,
  );
  if (!validWriter.ok) return validWriter;

  const created = await dependencies.creator.createTask(
    token,
    prepared.target,
    createMutation,
    prepared.fields,
  );
  if (!created.ok) return created;
  const createStage: TaskCreationStage = {
    stage: "create",
    status: "completed",
    applied: createMutation,
  };
  if (!dependencies.writer) {
    const stages: TaskCreationStage[] = [createStage];
    for (const [stage] of requestedStages) {
      stages.push({ stage, status: "not_run", reason: "not_requested" });
    }
    return ok({ task: created.value, stages, complete: true });
  }
  const applied = await applyCreationStages(
    token,
    created.value.gid,
    created.value,
    requestedStages,
    dependencies.writer,
    prepared.fields,
  );
  return ok({ ...applied, stages: [createStage, ...applied.stages] });
};

type TaskUpdatePlacement =
  | Readonly<{
      kind: "section";
      gid: string;
      writer: TaskSectionMutationGateway;
    }>
  | Readonly<{
      kind: "project";
      gid: string;
      writer: TaskProjectMutationGateway;
    }>
  | Readonly<{ kind: "mutation"; writer: TaskMutationGateway }>;

const resolveTaskUpdatePlacement = (
  prepared: PreparedTaskUpdate,
  dependencies: TaskUpdateDependencies,
): Result<TaskUpdatePlacement, TaskUpdateError> => {
  if (prepared.sectionGid !== undefined) {
    return dependencies.sectionWriter
      ? ok({
          kind: "section",
          gid: prepared.sectionGid,
          writer: dependencies.sectionWriter,
        })
      : err({
          kind: "internal_error",
          message: "Task section writer is required",
        });
  }
  if (prepared.projectGid !== undefined) {
    return dependencies.projectWriter
      ? ok({
          kind: "project",
          gid: prepared.projectGid,
          writer: dependencies.projectWriter,
        })
      : err({
          kind: "internal_error",
          message: "Task project writer is required",
        });
  }
  return ok({ kind: "mutation", writer: dependencies.writer });
};

const applyTaskUpdate = async (
  token: string,
  prepared: PreparedTaskUpdate,
  applied: TaskMutation,
  placement: TaskUpdatePlacement,
): Promise<Result<TaskUpdateResult, TaskUpdateError>> => {
  if (placement.kind === "section") {
    const moved = await placement.writer.moveTaskToSection(
      token,
      prepared.taskId,
      placement.gid,
      prepared.fields,
    );
    return moved.ok
      ? ok({ task: moved.value, applied: { section: placement.gid } })
      : moved;
  }
  if (placement.kind === "project") {
    const added = await placement.writer.addTaskToProject(
      token,
      prepared.taskId,
      placement.gid,
      prepared.fields,
    );
    return added.ok
      ? ok({ task: added.value, applied: { project: placement.gid } })
      : added;
  }
  const updated = await placement.writer.updateTask(
    token,
    prepared.taskId,
    applied,
    prepared.fields,
  );
  return updated.ok ? ok({ task: updated.value, applied }) : updated;
};

export const executeTaskUpdate = async (
  token: string,
  prepared: PreparedTaskUpdate,
  dependencies: TaskUpdateDependencies,
): Promise<Result<TaskUpdateResult, TaskUpdateError>> => {
  const placement = resolveTaskUpdatePlacement(prepared, dependencies);
  if (!placement.ok) return placement;
  const materialized = await materializeTaskMutation(
    token,
    { ...prepared, workflow: "update" },
    dependencies,
  );
  if (!materialized.ok) return materialized;
  return applyTaskUpdate(
    token,
    prepared,
    orderMutation(materialized.value),
    placement.value,
  );
};

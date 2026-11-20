import { collectPages } from "../pagination/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import { projectFields } from "../utils/project-fields.ts";
import type {
  MySectionResolver,
  PreparedTaskListRead,
  Task,
  TaskListAssigneeFilter,
  TaskListDependencies,
  TaskListGateway,
  TaskListMeta,
  TaskListPage,
  TaskListSource,
  TaskReadError,
  TaskUpdateError,
} from "./index.ts";

const EPOCH_COMPLETED_SINCE = "1970-01-01T00:00:00.000Z";

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

const collectTaskListPages = async (
  token: string,
  prepared: PreparedTaskListRead,
  dependencies: TaskListDependencies,
  source: ResolvedTaskListSource,
  assigneeGid: string | undefined,
): Promise<TaskListReadResult> => {
  const result = await collectPages<Task, Task, TaskUpdateError>(
    prepared,
    async (limit, offset) => {
      const page = await readTaskListPage(
        token,
        source,
        prepared,
        limit,
        offset,
        dependencies.reader,
      );
      if (!page.ok) return page;
      const { tasks, nextOffset } = page.value;
      return ok({ items: tasks, nextOffset });
    },
    (task) => {
      if (task.completed !== prepared.completed) return undefined;
      if (assigneeGid !== undefined && task.assignee?.gid !== assigneeGid)
        return undefined;
      return projectTaskListFields(task, prepared.outputFields);
    },
    { kind: "invalid_response", message: "Task pagination did not advance" },
  );
  return result.ok
    ? ok({ tasks: result.value.items, meta: result.value.meta })
    : result;
};

export const executeTaskListRead = async (
  token: string,
  prepared: PreparedTaskListRead,
  dependencies: TaskListDependencies,
): Promise<TaskListReadResult> => {
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

import { z } from "zod";

import type {
  Comment,
  TaskCommentCreationGateway,
  TaskStoryGateway,
} from "../comments/index.ts";
import type {
  DiscoveredMyTaskSections,
  MyTasksDiscoveryGateway,
  MyTaskSectionsDiscoveryGateway,
  DiscoveredMyTasks,
  DiscoveryError,
} from "../config/index.ts";
import type {
  Identity,
  IdentityError,
  IdentityGateway,
} from "../identity/index.ts";
import {
  type Task,
  type TaskGateway,
  type TaskCreationGateway,
  type TaskCreationTarget,
  type TaskListGateway,
  type TaskListPage,
  type TaskMutation,
  type TaskMutationGateway,
  type TaskParentMutationGateway,
  type TaskReadError,
} from "../tasks/index.ts";
import type {
  Workspace,
  WorkspaceGateway,
  WorkspaceListError,
} from "../workspaces/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import { projectFields } from "../utils/project-fields.ts";
import { resolvePath } from "../utils/resolve-path.ts";

const userSchema = z
  .object({ gid: z.string(), name: z.string() })
  .passthrough();

export type AsanaClientOptions = Readonly<{
  baseUrl?: string;
  maxRetries?: number;
  requestTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}>;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const retryAfterMs = (
  value: string | null,
  now: number,
): number | undefined => {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(value, key);

const isDigitOnlyGid = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value);

const isNullableNamedResource = (
  value: unknown,
  requestedFields: ReadonlySet<string>,
): boolean => {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (hasOwn(value, "gid") && !isDigitOnlyGid(value.gid)) return false;
  if (hasOwn(value, "name") && typeof value.name !== "string") return false;
  for (const field of requestedFields) {
    if (!hasOwn(value, field)) return false;
  }
  return true;
};

const knownTaskFieldsAreValid = (
  value: Record<string, unknown>,
  requestedAssigneeFields: ReadonlySet<string>,
): boolean =>
  (!hasOwn(value, "gid") || isDigitOnlyGid(value.gid)) &&
  (!hasOwn(value, "name") || typeof value.name === "string") &&
  (!hasOwn(value, "notes") || typeof value.notes === "string") &&
  (!hasOwn(value, "completed") || typeof value.completed === "boolean") &&
  (!hasOwn(value, "due_on") ||
    typeof value.due_on === "string" ||
    value.due_on === null) &&
  (!hasOwn(value, "assignee") ||
    isNullableNamedResource(value.assignee, requestedAssigneeFields));

const assigneeFieldsOf = (fields: readonly string[]): ReadonlySet<string> =>
  new Set(
    fields
      .filter((field) => field === "assignee.gid" || field === "assignee.name")
      .map((field) => field.slice("assignee.".length)),
  );

const taskMatchesFields = (
  value: unknown,
  fields: readonly string[],
): boolean => {
  const requestedTopLevelFields = new Set(
    fields.map((field) => field.split(".", 1)[0] ?? field),
  );
  return (
    isRecord(value) &&
    [...requestedTopLevelFields].every((field) => hasOwn(value, field)) &&
    knownTaskFieldsAreValid(value, assigneeFieldsOf(fields))
  );
};

const buildTaskSchema = (fields: readonly string[]): z.ZodType<Task> =>
  z.custom<Task>((value) => taskMatchesFields(value, fields));

const projectTaskFields = (
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> | undefined => {
  const projected = projectFields(value, fields);
  return projected.found ? projected.value : undefined;
};

// Mutations narrow the response to the selected paths, so unrequested Asana
// fields never leak into the output; reads keep their passthrough object.
const mutatedTaskMatches = (
  value: unknown,
  fields: readonly string[],
): boolean =>
  isRecord(value) &&
  knownTaskFieldsAreValid(value, assigneeFieldsOf(fields)) &&
  projectTaskFields(value, fields) !== undefined;

const buildMutatedTaskSchema = (
  fields: readonly string[] | undefined,
): z.ZodType<Task> =>
  fields === undefined
    ? buildTaskSchema([])
    : z
        .custom<Task>((value) => mutatedTaskMatches(value, fields))
        .transform((value) => projectTaskFields(value, fields) as Task);

const createdTaskMatches = (
  value: unknown,
  fields: readonly string[] | undefined,
): boolean =>
  isRecord(value) &&
  isDigitOnlyGid(value.gid) &&
  (fields === undefined
    ? knownTaskFieldsAreValid(value, new Set())
    : mutatedTaskMatches(value, fields));

const buildCreatedTaskSchema = (
  fields: readonly string[] | undefined,
): z.ZodType<Task & Readonly<{ gid: string }>> => {
  const schema = z.custom<Task & Readonly<{ gid: string }>>((value) =>
    createdTaskMatches(value, fields),
  );
  return fields === undefined
    ? schema
    : schema.transform(
        (value) =>
          projectTaskFields(value, fields) as Task & Readonly<{ gid: string }>,
      );
};

// Asana omits gid unless it is requested, but gid is the stable task identity
// and the handle staged creation writes need, so it is always selected.
const withGidField = (fields: readonly string[]): readonly string[] =>
  fields.includes("gid") ? fields : ["gid", ...fields];

const mutationFieldSelection = (
  fields: readonly string[] | undefined,
): Readonly<{
  searchParams?: Readonly<Record<string, string>>;
  fields?: readonly string[];
}> => {
  if (fields === undefined) return {};
  const selected = withGidField(fields);
  return {
    searchParams: { opt_fields: selected.join(",") },
    fields: selected,
  };
};

const knownCommentFieldsAreValid = (
  value: Record<string, unknown>,
  requestedCreatedByFields: ReadonlySet<string>,
): boolean =>
  (!hasOwn(value, "gid") || isDigitOnlyGid(value.gid)) &&
  (!hasOwn(value, "created_at") || typeof value.created_at === "string") &&
  (!hasOwn(value, "text") || typeof value.text === "string") &&
  (!hasOwn(value, "resource_subtype") ||
    typeof value.resource_subtype === "string") &&
  (!hasOwn(value, "created_by") ||
    isNullableNamedResource(value.created_by, requestedCreatedByFields));

const requestedCommentFieldIsPresent = (
  value: Record<string, unknown>,
  field: string,
): boolean => {
  const path = field.split(".");
  if (path[0] === "created_by" && value.created_by === null) return true;
  return resolvePath(value, path).found;
};

const buildCommentSchema = (fields: readonly string[]): z.ZodType<Comment> => {
  const requestedCreatedByFields = new Set(
    fields
      .filter(
        (field) => field === "created_by.gid" || field === "created_by.name",
      )
      .map((field) => field.slice("created_by.".length)),
  );
  return z.custom<Comment>(
    (value) =>
      isRecord(value) &&
      fields.every((field) => requestedCommentFieldIsPresent(value, field)) &&
      knownCommentFieldsAreValid(value, requestedCreatedByFields),
  );
};

const buildStoriesPageSchema = (fields: readonly string[]) =>
  z.object({
    data: z.array(buildCommentSchema(fields)),
    next_page: z
      .object({ offset: z.string() })
      .passthrough()
      .nullable()
      .optional(),
  });

const buildTaskListPageSchema = (fields: readonly string[]) =>
  z.object({
    data: z.array(buildTaskSchema(fields)),
    next_page: z
      .object({ offset: z.string() })
      .passthrough()
      .nullable()
      .optional(),
  });

const workspaceSchema = z
  .custom<Workspace>(
    (value) =>
      isRecord(value) &&
      isDigitOnlyGid(value.gid) &&
      typeof value.name === "string",
  )
  .transform((value): Workspace => ({ gid: value.gid, name: value.name }));

const workspacesPageSchema = z.object({
  data: z.array(workspaceSchema),
  next_page: z
    .object({ offset: z.string().min(1) })
    .passthrough()
    .nullable()
    .optional(),
});

export class AsanaHttpClient
  implements
    IdentityGateway,
    MyTasksDiscoveryGateway,
    MyTaskSectionsDiscoveryGateway,
    TaskGateway,
    TaskCreationGateway,
    TaskListGateway,
    TaskMutationGateway,
    TaskParentMutationGateway,
    TaskStoryGateway,
    TaskCommentCreationGateway,
    WorkspaceGateway
{
  readonly #baseUrl: string;
  readonly #maxRetries: number;
  readonly #requestTimeoutMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;

  constructor(options: AsanaClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? "https://app.asana.com/api/1.0";
    this.#maxRetries = options.maxRetries ?? 3;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#sleep = options.sleep ?? wait;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
  }

  async #request<T>(
    token: string,
    path: string,
    options: Readonly<{
      method: "GET" | "POST" | "PUT";
      searchParams?: Readonly<Record<string, string>>;
      body?: unknown;
    }>,
    schema: z.ZodType<T>,
  ): Promise<Result<T, IdentityError>> {
    const url = new URL(path, `${this.#baseUrl}/`);
    for (const [key, value] of Object.entries(options.searchParams ?? {})) {
      url.searchParams.set(key, value);
    }

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.#requestTimeoutMs,
      );
      try {
        const response = await fetch(url, {
          method: options.method,
          headers:
            options.body === undefined
              ? { Authorization: `Bearer ${token}` }
              : {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const retryable =
            options.method === "POST"
              ? response.status === 429
              : [429, 502, 503, 504].includes(response.status);
          if (retryable && attempt < this.#maxRetries) {
            await this.#sleep(
              this.retryDelay(attempt, response.headers.get("Retry-After")),
            );
            continue;
          }
          return err(this.responseError(response.status, retryable));
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return err({
            kind: "invalid_response",
            message: "Asana returned an invalid response",
          });
        }
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          return err({
            kind: "invalid_response",
            message: "Asana returned an invalid response",
          });
        }
        return ok(parsed.data);
      } catch {
        if (options.method !== "POST" && attempt < this.#maxRetries) {
          await this.#sleep(this.retryDelay(attempt));
          continue;
        }
        return err({ kind: "network", message: "Unable to reach Asana" });
      } finally {
        clearTimeout(timeout);
      }
    }
    return err({ kind: "network", message: "Unable to reach Asana" });
  }

  async getAuthenticatedUser(
    token: string,
  ): Promise<Result<Identity, IdentityError>> {
    const schema = z.object({ data: userSchema });
    const result = await this.#request(
      token,
      "users/me",
      { method: "GET", searchParams: { opt_fields: "gid,name" } },
      schema,
    );
    if (!result.ok) return result;
    return ok({ gid: result.value.data.gid, name: result.value.data.name });
  }

  async listWorkspaces(
    token: string,
    options: Readonly<{ limit: number; offset?: string }>,
  ): Promise<
    Result<
      Readonly<{ workspaces: readonly Workspace[]; nextOffset?: string }>,
      WorkspaceListError
    >
  > {
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    ) {
      return err({
        kind: "invalid_response",
        message: "Workspace page limit must be between 1 and 100",
      });
    }

    const result = await this.#request(
      token,
      "workspaces",
      {
        method: "GET",
        searchParams: {
          limit: String(options.limit),
          opt_fields: "gid,name",
          ...(options.offset === undefined ? {} : { offset: options.offset }),
        },
      },
      workspacesPageSchema,
    );
    if (!result.ok) return result;
    return ok({
      workspaces: result.value.data,
      ...(result.value.next_page?.offset === undefined
        ? {}
        : { nextOffset: result.value.next_page.offset }),
    });
  }

  async discoverMyTaskSections(
    token: string,
    workspaceGid: string,
  ): Promise<Result<DiscoveredMyTaskSections, DiscoveryError>> {
    const utlSchema = z
      .object({
        data: z
          .object({
            gid: z.string(),
            workspace: z.object({ gid: z.string() }).passthrough(),
          })
          .passthrough(),
      })
      .passthrough();

    const utlResult = await this.#request(
      token,
      "users/me/user_task_list",
      {
        method: "GET",
        searchParams: {
          workspace: workspaceGid,
          opt_fields: "gid,workspace.gid",
        },
      },
      utlSchema,
    );
    if (!utlResult.ok) return utlResult;

    const returnedWorkspaceGid = utlResult.value.data.workspace.gid;
    if (returnedWorkspaceGid !== workspaceGid) {
      return err({
        kind: "invalid_response",
        message: `Returned user task list workspace GID ${returnedWorkspaceGid} does not match requested workspace GID ${workspaceGid}`,
      });
    }

    const utlGid = utlResult.value.data.gid;

    const sectionsSchema = z
      .object({
        data: z.array(
          z
            .object({
              gid: z.string(),
              name: z.string(),
            })
            .passthrough(),
        ),
        next_page: z.nullable(z.unknown()).optional(),
      })
      .passthrough();

    const sectionsResult = await this.#request(
      token,
      `projects/${utlGid}/sections`,
      {
        method: "GET",
        searchParams: { limit: "100", opt_fields: "gid,name" },
      },
      sectionsSchema,
    );
    if (!sectionsResult.ok) return sectionsResult;
    if (
      sectionsResult.value.next_page !== null &&
      sectionsResult.value.next_page !== undefined
    ) {
      return err({
        kind: "invalid_response",
        message: "Asana returned more than 100 sections; next_page is present",
      });
    }

    return ok({
      userTaskListGid: utlGid,
      sections: sectionsResult.value.data.map((section) => ({
        gid: section.gid,
        name: section.name,
      })),
    });
  }

  async discoverMyTasks(
    token: string,
    workspaceGid: string,
  ): Promise<Result<DiscoveredMyTasks, DiscoveryError>> {
    const sections = await this.discoverMyTaskSections(token, workspaceGid);
    if (!sections.ok) return sections;
    const utlGid = sections.value.userTaskListGid;

    const enumOptionSchema = z
      .object({
        gid: z.custom<string>(isDigitOnlyGid),
        name: z.string(),
        enabled: z.boolean(),
      })
      .passthrough();

    const customFieldsSchema = z
      .object({
        data: z.array(
          z
            .object({
              custom_field: z
                .object({
                  gid: z.string(),
                  name: z.string(),
                  resource_subtype: z.string(),
                  is_value_read_only: z.boolean(),
                  enum_options: z.array(enumOptionSchema).optional(),
                })
                .passthrough(),
            })
            .passthrough(),
        ),
        next_page: z.nullable(z.unknown()).optional(),
      })
      .passthrough();

    const customFieldsResult = await this.#request(
      token,
      `projects/${utlGid}/custom_field_settings`,
      {
        method: "GET",
        searchParams: {
          limit: "100",
          opt_fields:
            "custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.is_value_read_only,custom_field.enum_options.gid,custom_field.enum_options.name,custom_field.enum_options.enabled",
        },
      },
      customFieldsSchema,
    );
    if (!customFieldsResult.ok) return customFieldsResult;
    if (
      customFieldsResult.value.next_page !== null &&
      customFieldsResult.value.next_page !== undefined
    ) {
      return err({
        kind: "invalid_response",
        message:
          "Asana returned more than 100 custom field settings; next_page is present",
      });
    }
    const customFields: DiscoveredMyTasks["customFields"][number][] = [];
    for (const setting of customFieldsResult.value.data) {
      const field = setting.custom_field;
      const base = {
        gid: field.gid,
        name: field.name,
        isReadOnly: field.is_value_read_only,
      };
      if (field.resource_subtype === "number") {
        customFields.push({ ...base, resourceSubtype: "number" });
        continue;
      }
      if (field.resource_subtype === "enum") {
        if (field.enum_options === undefined) {
          return err({
            kind: "invalid_response",
            message: `Asana returned enum custom field ${field.gid} without enum_options`,
          });
        }
        customFields.push({
          ...base,
          resourceSubtype: "enum",
          enumOptions: field.enum_options.map((option) => ({
            gid: option.gid,
            name: option.name,
            enabled: option.enabled,
          })),
        });
        continue;
      }
      customFields.push({
        ...base,
        resourceSubtype: "unsupported",
        originalResourceSubtype: field.resource_subtype,
      });
    }

    return ok({
      userTaskListGid: utlGid,
      sections: sections.value.sections,
      customFields,
    });
  }

  async getTask(
    token: string,
    taskId: string,
    fields: readonly string[],
  ): Promise<Result<Task, TaskReadError>> {
    if (!/^\d+$/.test(taskId)) {
      return err({
        kind: "invalid_response",
        message: "Task GID is not digit-only",
      });
    }

    const taskSchema = buildTaskSchema(fields);
    const schema = z.object({ data: taskSchema });

    const result = await this.#request(
      token,
      `tasks/${taskId}`,
      { method: "GET", searchParams: { opt_fields: fields.join(",") } },
      schema,
    );
    if (!result.ok) {
      if (result.error.kind === "api" && result.error.status === 404) {
        return err({
          kind: "not_found",
          status: 404,
          message: "Task not found",
        });
      }
      return result;
    }
    return ok(result.value.data);
  }

  async updateTask(
    token: string,
    taskId: string,
    mutation: TaskMutation,
    fields?: readonly string[],
  ): Promise<Result<Task, TaskReadError>> {
    if (!/^\d+$/.test(taskId)) {
      return err({
        kind: "invalid_response",
        message: "Task GID is not digit-only",
      });
    }

    const selection = mutationFieldSelection(fields);
    const schema = z.object({ data: buildMutatedTaskSchema(selection.fields) });
    const result = await this.#request(
      token,
      `tasks/${taskId}`,
      {
        method: "PUT",
        ...(selection.searchParams === undefined
          ? {}
          : { searchParams: selection.searchParams }),
        body: { data: mutation },
      },
      schema,
    );
    if (!result.ok) {
      if (result.error.kind === "api" && result.error.status === 404) {
        return err({
          kind: "not_found",
          status: 404,
          message: "Task not found",
        });
      }
      return result;
    }
    return ok(result.value.data);
  }

  async setTaskParent(
    token: string,
    taskId: string,
    parentId: string | null,
    fields?: readonly string[],
  ): Promise<Result<Task, TaskReadError>> {
    if (!/^\d+$/.test(taskId)) {
      return err({
        kind: "invalid_response",
        message: "Task GID is not digit-only",
      });
    }
    if (parentId !== null && !/^\d+$/.test(parentId)) {
      return err({
        kind: "invalid_response",
        message: "Parent task GID is not digit-only",
      });
    }

    const selection = mutationFieldSelection(fields);
    const schema = z.object({ data: buildMutatedTaskSchema(selection.fields) });
    const result = await this.#request(
      token,
      `tasks/${taskId}/setParent`,
      {
        method: "POST",
        ...(selection.searchParams === undefined
          ? {}
          : { searchParams: selection.searchParams }),
        body: { data: { parent: parentId } },
      },
      schema,
    );
    if (!result.ok) {
      if (result.error.kind === "api" && result.error.status === 404) {
        return err({
          kind: "not_found",
          status: 404,
          message: "Task not found",
        });
      }
      return result;
    }
    return ok(result.value.data);
  }

  async createTask(
    token: string,
    target: TaskCreationTarget,
    mutation: TaskMutation,
    fields?: readonly string[],
  ): Promise<Result<Task & Readonly<{ gid: string }>, TaskReadError>> {
    const targetGid =
      target.kind === "subtask"
        ? target.parentId
        : target.kind === "workspace"
          ? target.workspaceGid
          : target.projectGid;
    if (!/^\d+$/.test(targetGid)) {
      return err({
        kind: "invalid_response",
        message: "Task creation target GID is not digit-only",
      });
    }

    const path =
      target.kind === "subtask" ? `tasks/${target.parentId}/subtasks` : "tasks";
    const data =
      target.kind === "workspace"
        ? { ...mutation, workspace: target.workspaceGid }
        : target.kind === "project"
          ? { ...mutation, projects: [target.projectGid] }
          : mutation;
    const selection = mutationFieldSelection(fields);
    const schema = z.object({ data: buildCreatedTaskSchema(selection.fields) });
    const result = await this.#request(
      token,
      path,
      {
        method: "POST",
        ...(selection.searchParams === undefined
          ? {}
          : { searchParams: selection.searchParams }),
        body: { data },
      },
      schema,
    );
    if (!result.ok) {
      if (result.error.kind === "api" && result.error.status === 404) {
        return err({
          kind: "not_found",
          status: 404,
          message: "Task not found",
        });
      }
      return result;
    }
    return ok(result.value.data);
  }

  async getTaskStories(
    token: string,
    taskId: string,
    options: Readonly<{
      fields: readonly string[];
      limit: number;
      offset?: string;
    }>,
  ): Promise<
    Result<
      Readonly<{
        stories: readonly Comment[];
        nextOffset?: string;
      }>,
      TaskReadError
    >
  > {
    if (!/^\d+$/.test(taskId)) {
      return err({
        kind: "invalid_response",
        message: "Task GID is not digit-only",
      });
    }
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    ) {
      return err({
        kind: "invalid_response",
        message: "Story page limit must be between 1 and 100",
      });
    }

    const result = await this.#request(
      token,
      `tasks/${taskId}/stories`,
      {
        method: "GET",
        searchParams: {
          limit: String(options.limit),
          opt_fields: options.fields.join(","),
          ...(options.offset === undefined ? {} : { offset: options.offset }),
        },
      },
      buildStoriesPageSchema(options.fields),
    );
    if (!result.ok) {
      if (result.error.kind === "api" && result.error.status === 404) {
        return err({
          kind: "not_found",
          status: 404,
          message: "Task not found",
        });
      }
      return result;
    }
    return ok({
      stories: result.value.data,
      ...(result.value.next_page?.offset === undefined
        ? {}
        : { nextOffset: result.value.next_page.offset }),
    });
  }

  async #getTasksForResource(
    token: string,
    path: string,
    options: Readonly<{
      fields: readonly string[];
      limit: number;
      offset?: string;
      completedSince: string;
    }>,
  ): Promise<Result<TaskListPage, TaskReadError>> {
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    ) {
      return err({
        kind: "invalid_response",
        message: "Task page limit must be between 1 and 100",
      });
    }

    const result = await this.#request(
      token,
      path,
      {
        method: "GET",
        searchParams: {
          limit: String(options.limit),
          opt_fields: options.fields.join(","),
          completed_since: options.completedSince,
          ...(options.offset === undefined ? {} : { offset: options.offset }),
        },
      },
      buildTaskListPageSchema(options.fields),
    );
    if (!result.ok) {
      if (result.error.kind === "api" && result.error.status === 404) {
        return err({
          kind: "not_found",
          status: 404,
          message: "Resource not found",
        });
      }
      return result;
    }
    return ok({
      tasks: result.value.data,
      ...(result.value.next_page?.offset === undefined
        ? {}
        : { nextOffset: result.value.next_page.offset }),
    });
  }

  async getSectionTasks(
    token: string,
    sectionGid: string,
    options: Readonly<{
      fields: readonly string[];
      limit: number;
      offset?: string;
      completedSince: string;
    }>,
  ): Promise<Result<TaskListPage, TaskReadError>> {
    if (!/^\d+$/.test(sectionGid)) {
      return err({
        kind: "invalid_response",
        message: "Section GID is not digit-only",
      });
    }
    return this.#getTasksForResource(
      token,
      `sections/${sectionGid}/tasks`,
      options,
    );
  }

  async getProjectTasks(
    token: string,
    projectGid: string,
    options: Readonly<{
      fields: readonly string[];
      limit: number;
      offset?: string;
      completedSince: string;
    }>,
  ): Promise<Result<TaskListPage, TaskReadError>> {
    if (!/^\d+$/.test(projectGid)) {
      return err({
        kind: "invalid_response",
        message: "Project GID is not digit-only",
      });
    }
    return this.#getTasksForResource(
      token,
      `projects/${projectGid}/tasks`,
      options,
    );
  }

  async createTaskComment(
    token: string,
    taskId: string,
    text: string,
    fields: readonly string[],
  ): Promise<Result<Comment, TaskReadError>> {
    if (!/^\d+$/.test(taskId)) {
      return err({
        kind: "invalid_response",
        message: "Task GID is not digit-only",
      });
    }

    const result = await this.#request(
      token,
      `tasks/${taskId}/stories`,
      {
        method: "POST",
        searchParams: { opt_fields: fields.join(",") },
        body: { data: { text } },
      },
      z.object({ data: buildCommentSchema(fields) }),
    );
    if (!result.ok) {
      if (result.error.kind === "api" && result.error.status === 404) {
        return err({
          kind: "not_found",
          status: 404,
          message: "Task not found",
        });
      }
      return result;
    }
    return ok(result.value.data);
  }

  private retryDelay(
    attempt: number,
    retryAfter: string | null = null,
  ): number {
    return (
      retryAfterMs(retryAfter, this.#now()) ??
      1_000 * 2 ** attempt + Math.floor(this.#random() * 1_000)
    );
  }

  private responseError(status: number, retryable: boolean): IdentityError {
    if (status === 401 || status === 403) {
      return {
        kind: "authentication",
        status,
        message: "Asana authentication failed",
      };
    }
    return retryable
      ? {
          kind: "rate_limit",
          status,
          message: "Asana request retries exhausted",
        }
      : {
          kind: "api",
          status,
          message: `Asana API request failed (${status})`,
        };
  }
}

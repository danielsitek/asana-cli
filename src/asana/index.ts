import { z } from "zod";

import type {
  MyTasksDiscoveryGateway,
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
  type TaskMutation,
  type TaskMutationGateway,
  type TaskReadError,
} from "../tasks/index.ts";
import { err, ok, type Result } from "../shared/result.ts";

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

const isAssignee = (
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
    isAssignee(value.assignee, requestedAssigneeFields));

const buildTaskSchema = (fields: readonly string[]): z.ZodType<Task> => {
  const requestedTopLevelFields = new Set(
    fields.map((field) => field.split(".", 1)[0] ?? field),
  );
  const requestedAssigneeFields = new Set(
    fields
      .filter((field) => field === "assignee.gid" || field === "assignee.name")
      .map((field) => field.slice("assignee.".length)),
  );
  return z.custom<Task>(
    (value) =>
      isRecord(value) &&
      [...requestedTopLevelFields].every((field) => hasOwn(value, field)) &&
      knownTaskFieldsAreValid(value, requestedAssigneeFields),
  );
};

const createdTaskSchema = z.custom<Task & Readonly<{ gid: string }>>(
  (value) =>
    isRecord(value) &&
    isDigitOnlyGid(value.gid) &&
    knownTaskFieldsAreValid(value, new Set()),
);

export class AsanaHttpClient
  implements
    IdentityGateway,
    MyTasksDiscoveryGateway,
    TaskGateway,
    TaskCreationGateway,
    TaskMutationGateway
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

  async discoverMyTasks(
    token: string,
    workspaceGid: string,
  ): Promise<Result<DiscoveredMyTasks, DiscoveryError>> {
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
            "custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.is_value_read_only",
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

    return ok({
      userTaskListGid: utlGid,
      sections: sectionsResult.value.data.map((s) => ({
        gid: s.gid,
        name: s.name,
      })),
      customFields: customFieldsResult.value.data.map((c) => ({
        gid: c.custom_field.gid,
        name: c.custom_field.name,
        resourceSubtype: c.custom_field.resource_subtype,
        isReadOnly: c.custom_field.is_value_read_only,
      })),
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
  ): Promise<Result<Task, TaskReadError>> {
    if (!/^\d+$/.test(taskId)) {
      return err({
        kind: "invalid_response",
        message: "Task GID is not digit-only",
      });
    }

    const schema = z.object({ data: buildTaskSchema([]) });
    const result = await this.#request(
      token,
      `tasks/${taskId}`,
      { method: "PUT", body: { data: mutation } },
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

  async createSubtask(
    token: string,
    parentId: string,
    mutation: TaskMutation,
  ): Promise<Result<Task & Readonly<{ gid: string }>, TaskReadError>> {
    if (!/^\d+$/.test(parentId)) {
      return err({
        kind: "invalid_response",
        message: "Task GID is not digit-only",
      });
    }

    const schema = z.object({ data: createdTaskSchema });
    const result = await this.#request(
      token,
      `tasks/${parentId}/subtasks`,
      { method: "POST", body: { data: mutation } },
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

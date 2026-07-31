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

export class AsanaHttpClient
  implements IdentityGateway, MyTasksDiscoveryGateway
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

  async #get<T>(
    token: string,
    path: string,
    searchParams: Readonly<Record<string, string>>,
    schema: z.ZodType<T>,
  ): Promise<Result<T, IdentityError>> {
    const url = new URL(path, `${this.#baseUrl}/`);
    for (const [key, value] of Object.entries(searchParams)) {
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
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!response.ok) {
          const retryable = [429, 502, 503, 504].includes(response.status);
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
        if (attempt < this.#maxRetries) {
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
    const result = await this.#get(
      token,
      "users/me",
      { opt_fields: "gid,name" },
      schema,
    );
    if (!result.ok) return result;
    return ok({ gid: result.value.data.gid, name: result.value.data.name });
  }

  async discoverMyTasks(
    token: string,
    workspaceGid: string,
  ): Promise<Result<DiscoveredMyTasks, DiscoveryError>> {
    // 1. Get UTL
    const utlSchema = z
      .object({
        data: z
          .object({
            gid: z.string(),
            workspace: z.object({ gid: z.string() }).strict(),
          })
          .strict(),
      })
      .strict();

    const utlResult = await this.#get(
      token,
      "users/me/user_task_list",
      {
        workspace: workspaceGid,
        opt_fields: "gid,workspace.gid",
      },
      utlSchema,
    );
    if (!utlResult.ok) return utlResult;
    const utlGid = utlResult.value.data.gid;

    // 2. Get Sections
    const sectionsSchema = z
      .object({
        data: z.array(
          z
            .object({
              gid: z.string(),
              name: z.string(),
            })
            .strict(),
        ),
        next_page: z.nullable(z.unknown()).optional(),
      })
      .strict();

    const sectionsResult = await this.#get(
      token,
      `projects/${utlGid}/sections`,
      {
        limit: "100",
        opt_fields: "gid,name",
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

    // 3. Get Custom Fields
    const customFieldsSchema = z
      .object({
        data: z.array(
          z
            .object({
              gid: z.string(),
              custom_field: z
                .object({
                  gid: z.string(),
                  name: z.string(),
                  resource_subtype: z.string(),
                  is_value_read_only: z.boolean(),
                })
                .strict(),
            })
            .strict(),
        ),
        next_page: z.nullable(z.unknown()).optional(),
      })
      .strict();

    const customFieldsResult = await this.#get(
      token,
      `projects/${utlGid}/custom_field_settings`,
      {
        limit: "100",
        opt_fields:
          "gid,custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.is_value_read_only",
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

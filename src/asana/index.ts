import { z } from "zod";

import { err, ok, type Result } from "../shared/result.ts";

const userSchema = z
  .object({ gid: z.string(), name: z.string() })
  .passthrough();
const envelopeSchema = z.object({ data: userSchema });

export type Identity = Readonly<{ gid: string; name: string }>;

export type AsanaError = Readonly<{
  kind:
    | "authentication"
    | "api"
    | "rate_limit"
    | "network"
    | "invalid_response";
  message: string;
  status?: number;
}>;

export interface IdentityGateway {
  getAuthenticatedUser(token: string): Promise<Result<Identity, AsanaError>>;
}

export type AsanaClientOptions = Readonly<{
  baseUrl?: string;
  maxRetries?: number;
  requestTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}>;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const retryAfterMs = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
};

export class AsanaHttpClient implements IdentityGateway {
  readonly #baseUrl: string;
  readonly #maxRetries: number;
  readonly #requestTimeoutMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;

  constructor(options: AsanaClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? "https://app.asana.com/api/1.0";
    this.#maxRetries = options.maxRetries ?? 3;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#sleep = options.sleep ?? wait;
    this.#random = options.random ?? Math.random;
  }

  async getAuthenticatedUser(
    token: string,
  ): Promise<Result<Identity, AsanaError>> {
    const url = new URL("users/me", `${this.#baseUrl}/`);
    url.searchParams.set("opt_fields", "gid,name");

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
              retryAfterMs(response.headers.get("Retry-After")) ??
                1_000 * 2 ** attempt + Math.floor(this.#random() * 1_000),
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
        const parsed = envelopeSchema.safeParse(body);
        return parsed.success
          ? ok({ gid: parsed.data.data.gid, name: parsed.data.data.name })
          : err({
              kind: "invalid_response",
              message: "Asana returned an invalid response",
            });
      } catch {
        if (attempt < this.#maxRetries) {
          await this.#sleep(
            1_000 * 2 ** attempt + Math.floor(this.#random() * 1_000),
          );
          continue;
        }
        return err({ kind: "network", message: "Unable to reach Asana" });
      } finally {
        clearTimeout(timeout);
      }
    }
    return err({ kind: "network", message: "Unable to reach Asana" });
  }

  private responseError(status: number, retryable: boolean): AsanaError {
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

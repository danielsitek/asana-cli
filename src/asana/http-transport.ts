import { z } from "zod";

import type { IdentityError } from "../identity/index.ts";
import { err, ok, type Result } from "../shared/result.ts";

export type HttpRequestOptions = Readonly<{
  method: "GET" | "POST" | "PUT";
  searchParams?: Readonly<Record<string, string>>;
  body?: unknown;
}>;

export type HttpTransportOptions = Readonly<{
  baseUrl?: string;
  maxRetries?: number;
  requestTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}>;

type RetryOutcome = Readonly<{
  kind: "retry";
  error: IdentityError;
  retryAfter: string | null;
}>;

type AttemptOutcome<T> =
  | Readonly<{ kind: "complete"; result: Result<T, IdentityError> }>
  | RetryOutcome;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const defaultTo = <T>(value: T | undefined, fallback: T): T =>
  value ?? fallback;

const invalidResponse = (): IdentityError => ({
  kind: "invalid_response",
  message: "Asana returned an invalid response",
});

const networkError = (): IdentityError => ({
  kind: "network",
  message: "Unable to reach Asana",
});

const responseError = (status: number, retryable: boolean): IdentityError => {
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
};

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

const requestUrl = (
  baseUrl: string,
  path: string,
  searchParams: Readonly<Record<string, string>> | undefined,
): URL => {
  const url = new URL(path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
};

const requestInit = (
  token: string,
  options: HttpRequestOptions,
  signal: AbortSignal,
): RequestInit => ({
  method: options.method,
  headers:
    options.body === undefined
      ? { Authorization: `Bearer ${token}` }
      : {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
  ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  signal,
});

const responseIsRetryable = (
  method: HttpRequestOptions["method"],
  status: number,
): boolean =>
  method === "POST" ? status === 429 : [429, 502, 503, 504].includes(status);

const failedResponseOutcome = (
  method: HttpRequestOptions["method"],
  response: Response,
): AttemptOutcome<never> => {
  const retryable = responseIsRetryable(method, response.status);
  const error = responseError(response.status, retryable);
  return retryable
    ? {
        kind: "retry",
        error,
        retryAfter: response.headers.get("Retry-After"),
      }
    : { kind: "complete", result: err(error) };
};

const networkFailureOutcome = (
  method: HttpRequestOptions["method"],
): AttemptOutcome<never> => {
  const error = networkError();
  return method === "POST"
    ? { kind: "complete", result: err(error) }
    : { kind: "retry", error, retryAfter: null };
};

const parseResponse = async <T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<Result<T, IdentityError>> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return err(invalidResponse());
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? ok(parsed.data) : err(invalidResponse());
};

export class AsanaHttpTransport {
  readonly #baseUrl: string;
  readonly #maxRetries: number;
  readonly #requestTimeoutMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;

  constructor(options: HttpTransportOptions = {}) {
    this.#baseUrl = defaultTo(options.baseUrl, "https://app.asana.com/api/1.0");
    this.#maxRetries = defaultTo(options.maxRetries, 3);
    this.#requestTimeoutMs = defaultTo(options.requestTimeoutMs, 30_000);
    this.#sleep = defaultTo(options.sleep, wait);
    this.#random = defaultTo(options.random, Math.random);
    this.#now = defaultTo(options.now, Date.now);
  }

  async request<T>(
    token: string,
    path: string,
    options: HttpRequestOptions,
    schema: z.ZodType<T>,
  ): Promise<Result<T, IdentityError>> {
    const url = requestUrl(this.#baseUrl, path, options.searchParams);
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const outcome = await this.executeAttempt(token, url, options, schema);
      if (outcome.kind === "complete") return outcome.result;
      if (attempt === this.#maxRetries) return err(outcome.error);
      await this.#sleep(this.retryDelay(attempt, outcome.retryAfter));
    }
    return err(networkError());
  }

  private async executeAttempt<T>(
    token: string,
    url: URL,
    options: HttpRequestOptions,
    schema: z.ZodType<T>,
  ): Promise<AttemptOutcome<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#requestTimeoutMs,
    );
    try {
      const response = await fetch(
        url,
        requestInit(token, options, controller.signal),
      );
      return response.ok
        ? { kind: "complete", result: await parseResponse(response, schema) }
        : failedResponseOutcome(options.method, response);
    } catch {
      return networkFailureOutcome(options.method);
    } finally {
      clearTimeout(timeout);
    }
  }

  private retryDelay(attempt: number, retryAfter: string | null): number {
    return (
      retryAfterMs(retryAfter, this.#now()) ??
      1_000 * 2 ** attempt + Math.floor(this.#random() * 1_000)
    );
  }
}

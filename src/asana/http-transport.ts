import { z } from "zod";

import type { IdentityError } from "../identity/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type { WriteOutcomeUnknown } from "../tasks/index.ts";

type RequestData = Readonly<{
  searchParams?: Readonly<Record<string, string>>;
  body?: unknown;
}>;

export type HttpRequestOptions = RequestData &
  Readonly<{ method: "GET" | "PUT" }>;

export type PostRequestOptions = RequestData &
  Readonly<{ method: "POST"; outcomeUnknownHint: string }>;

type RequestOptions = HttpRequestOptions | PostRequestOptions;
type RequestError = IdentityError | WriteOutcomeUnknown;

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
  | Readonly<{ kind: "complete"; result: Result<T, RequestError> }>
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

const unknownWriteOutcome = (
  options: PostRequestOptions,
  status?: number,
): WriteOutcomeUnknown => ({
  kind: "outcome_unknown",
  message: "Asana may have applied the write",
  retryable: false,
  hint: options.outcomeUnknownHint,
  ...(status === undefined ? {} : { status }),
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
  options: RequestOptions,
  signal: AbortSignal,
): RequestInit => ({
  method: options.method,
  headers:
    options.body === undefined
      ? { Authorization: `Bearer ${token}` }
      : options.body instanceof FormData
        ? { Authorization: `Bearer ${token}` }
        : {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
  ...(options.body === undefined
    ? {}
    : {
        body:
          options.body instanceof FormData
            ? options.body
            : JSON.stringify(options.body),
      }),
  signal,
});

const responseIsRetryable = (
  method: RequestOptions["method"],
  status: number,
): boolean =>
  method === "POST" ? status === 429 : [429, 502, 503, 504].includes(status);

const failedResponseOutcome = (
  options: RequestOptions,
  response: Response,
): AttemptOutcome<never> => {
  if (options.method === "POST" && response.status >= 500) {
    return {
      kind: "complete",
      result: err(unknownWriteOutcome(options, response.status)),
    };
  }
  const retryable = responseIsRetryable(options.method, response.status);
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
  options: RequestOptions,
): AttemptOutcome<never> => {
  return options.method === "POST"
    ? { kind: "complete", result: err(unknownWriteOutcome(options)) }
    : { kind: "retry", error: networkError(), retryAfter: null };
};

const parseResponse = async <T>(
  response: Response,
  schema: z.ZodType<T>,
  options: RequestOptions,
): Promise<Result<T, RequestError>> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (options.method === "POST" && !(error instanceof SyntaxError)) {
      return err(unknownWriteOutcome(options));
    }
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

  request<T>(
    token: string,
    path: string,
    options: HttpRequestOptions,
    schema: z.ZodType<T>,
  ): Promise<Result<T, IdentityError>>;
  request<T>(
    token: string,
    path: string,
    options: PostRequestOptions,
    schema: z.ZodType<T>,
  ): Promise<Result<T, RequestError>>;
  async request<T>(
    token: string,
    path: string,
    options: RequestOptions,
    schema: z.ZodType<T>,
  ): Promise<Result<T, RequestError>> {
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
    options: RequestOptions,
    schema: z.ZodType<T>,
  ): Promise<AttemptOutcome<T>> {
    const controller = new AbortController();
    const init = requestInit(token, options, controller.signal);
    const timeout = setTimeout(
      () => controller.abort(),
      this.#requestTimeoutMs,
    );
    try {
      const response = await fetch(url, init);
      return response.ok
        ? {
            kind: "complete",
            result: await parseResponse(response, schema, options),
          }
        : failedResponseOutcome(options, response);
    } catch {
      return networkFailureOutcome(options);
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

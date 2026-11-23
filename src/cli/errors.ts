import {
  ASANA_FAILURE_MESSAGES,
  type IdentityError,
} from "../identity/index.ts";
import {
  ERROR_CONTRACT,
  type CliError,
  type ErrorCode,
} from "../shared/errors.ts";
import type { WriteOutcomeUnknown } from "../tasks/index.ts";

export const ASANA_ERROR_CODES = Object.keys(
  ASANA_FAILURE_MESSAGES,
) as IdentityError["kind"][];

export const commandError = (
  code: ErrorCode,
  message: string,
  extra: Omit<CliError, "code" | "message" | "retryable"> = {},
) => {
  const { exit_code, retryable } = ERROR_CONTRACT[code];
  return { error: { code, message, retryable, ...extra }, exitCode: exit_code };
};

export const asanaFailure = (
  error: IdentityError<"not_found"> | WriteOutcomeUnknown,
  notFoundMessage = "Task not found",
) => {
  const { kind, status } = error;
  const message =
    kind === "not_found"
      ? notFoundMessage
      : kind === "outcome_unknown"
        ? "Asana may have applied the write"
        : ASANA_FAILURE_MESSAGES[kind];
  const upstreamMessage = error.asanaMessage;
  const details = {
    ...(status !== undefined &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? { status }
      : {}),
    ...(upstreamMessage === undefined ? {} : { message: upstreamMessage }),
  };
  return commandError(kind, message, {
    ...(Object.keys(details).length === 0 ? {} : { details }),
    ...(error.hint === undefined
      ? {}
      : { hint: error.hint, hints: [error.hint] }),
  });
};

export const ERROR_CONTRACT = {
  invalid_usage: { exit_code: 2, retryable: false },
  already_exists: { exit_code: 2, retryable: false },
  configuration: { exit_code: 2, retryable: false },
  authentication: { exit_code: 3, retryable: false },
  permission_denied: { exit_code: 3, retryable: false },
  api: { exit_code: 4, retryable: false },
  not_found: { exit_code: 4, retryable: false },
  timeout: { exit_code: 4, retryable: false },
  network: { exit_code: 4, retryable: true },
  invalid_response: { exit_code: 4, retryable: false },
  outcome_unknown: { exit_code: 4, retryable: false },
  rate_limit: { exit_code: 5, retryable: true },
  upstream_unavailable: { exit_code: 5, retryable: true },
  scan_limit: { exit_code: 5, retryable: false },
  invalid_state: { exit_code: 2, retryable: false },
  internal_error: { exit_code: 6, retryable: false },
} as const;

export type ErrorCode = keyof typeof ERROR_CONTRACT;

export type ErrorAdvice = Readonly<{
  allowed_values?: readonly string[];
  usage?: string;
  hints?: readonly string[];
}>;

export type ErrorDetails = Readonly<{ status?: number; message?: string }>;

export type CliError = ErrorAdvice &
  Readonly<{
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details?: ErrorDetails;
    hint?: string;
  }>;

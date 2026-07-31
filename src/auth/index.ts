import { err, ok, type Result } from "../shared/result.ts";

export type AuthenticationError = {
  readonly kind: "missing_token";
  readonly message: string;
};

export const resolveToken = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<string, AuthenticationError> => {
  const token = environment.ASANA_CLI_TOKEN;
  return token === undefined || token.trim() === ""
    ? err({ kind: "missing_token", message: "ASANA_CLI_TOKEN is required" })
    : ok(token);
};

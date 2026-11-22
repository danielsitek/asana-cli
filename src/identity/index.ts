import type { Result } from "../shared/result.ts";

export type Identity = Readonly<{ gid: string; name: string }>;

export type IdentityError<Kind extends string = never> = Readonly<{
  kind:
    | Kind
    | "authentication"
    | "permission_denied"
    | "upstream_unavailable"
    | "api"
    | "rate_limit"
    | "network"
    | "invalid_response";
  message: string;
  status?: number;
  asanaMessage?: string;
}>;

export interface IdentityGateway {
  getAuthenticatedUser(token: string): Promise<Result<Identity, IdentityError>>;
}

export const ASANA_FAILURE_MESSAGES: Record<IdentityError["kind"], string> = {
  authentication: "Asana authentication failed",
  permission_denied: "Asana permission denied",
  api: "Asana API request failed",
  rate_limit: "Asana request retries exhausted",
  upstream_unavailable: "Asana is temporarily unavailable",
  network: "Unable to reach Asana",
  invalid_response: "Asana returned an invalid response",
};

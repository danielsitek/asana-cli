import type { Result } from "../shared/result.ts";

export type Identity = Readonly<{ gid: string; name: string }>;

export type IdentityError = Readonly<{
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
  getAuthenticatedUser(token: string): Promise<Result<Identity, IdentityError>>;
}

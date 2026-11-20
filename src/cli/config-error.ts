import type { ConfigError } from "../config/index.ts";
import type { CommandResult } from "./contracts.ts";

export const renderConfigFailure = (error: ConfigError): CommandResult => ({
  error: { code: "configuration", message: error.message },
  exitCode: 2,
});

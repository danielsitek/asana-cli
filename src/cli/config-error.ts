import { commandError } from "./errors.ts";
import type { ConfigError } from "../config/index.ts";
import type { CommandResult } from "./contracts.ts";

export const renderConfigFailure = (error: ConfigError): CommandResult =>
  commandError("configuration", error.message);

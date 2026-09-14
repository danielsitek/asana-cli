import type { ConfigError } from "../config/index.ts";
import { renderError } from "../output/index.ts";
import type { Execution } from "./contracts.ts";

export const renderConfigFailure = (error: ConfigError): Execution => ({
  stdout: "",
  stderr: renderError({ code: "configuration", message: error.message }),
  exitCode: 2,
});

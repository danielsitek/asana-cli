import { homedir } from "node:os";

import { AsanaHttpClient } from "./asana/index.ts";
import { execute } from "./cli/index.ts";

declare const __APP_VERSION__: string | undefined;

const version = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.1.0";
const client = new AsanaHttpClient();
const result = await execute(Bun.argv.slice(2), {
  environment: process.env,
  identity: client,
  discovery: client,
  configuration: {
    cwd: process.cwd(),
    home: homedir(),
    environment: process.env,
  },
  version,
});

process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;

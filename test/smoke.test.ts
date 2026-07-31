import { test } from "bun:test";

import { runExecutableSmoke } from "../scripts/smoke-executable.ts";

const compiledTest = process.env.RUN_COMPILED_SMOKE === "1" ? test : test.skip;

compiledTest("compiled executable passes packaged smoke checks", async () => {
  await runExecutableSmoke("./dist/asana-cli");
});

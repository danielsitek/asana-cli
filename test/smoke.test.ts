import { expect, test } from "bun:test";

const compiledTest = process.env.RUN_COMPILED_SMOKE === "1" ? test : test.skip;

compiledTest("compiled executable prints help", async () => {
  const command = Bun.spawn(["./dist/asana-cli", "--help"], {
    stdout: "pipe",
  });
  const output = await new Response(command.stdout).text();
  expect(await command.exited).toBe(0);
  expect(output).toContain("whoami");
});

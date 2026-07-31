import { expect, test } from "bun:test";

const compiledTest = process.env.RUN_COMPILED_SMOKE === "1" ? test : test.skip;

compiledTest("compiled executable prints help without arguments", async () => {
  const command = Bun.spawn(["./dist/asana-cli"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(command.stdout).text();
  const errorOutput = await new Response(command.stderr).text();
  expect(await command.exited).toBe(0);
  expect(errorOutput).toBe("");
  expect(output).toContain("Usage: asana-cli");
  expect(output).toContain("whoami");
});

compiledTest("compiled executable version matches package.json", async () => {
  const manifest = (await Bun.file("package.json").json()) as {
    version: string;
  };
  const command = Bun.spawn(["./dist/asana-cli", "-v"], {
    stdout: "pipe",
  });
  const output = await new Response(command.stdout).text();
  expect(await command.exited).toBe(0);
  expect(output).toBe(`${manifest.version}\n`);
});

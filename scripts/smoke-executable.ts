import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { z } from "zod";

type CommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

const packageManifest = z.object({ version: z.string().min(1) });

const runCommand = async (
  binary: string,
  args: readonly string[],
  options: Readonly<{
    cwd?: string;
    env?: Readonly<Record<string, string>>;
  }> = {},
): Promise<CommandResult> => {
  const process = Bun.spawn([binary, ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const requireResult = (
  result: CommandResult,
  expected: Readonly<{
    exitCode: number;
    stdoutIncludes?: string;
    stderrIncludes?: string;
    stderr?: string;
  }>,
  label: string,
): void => {
  if (
    result.exitCode !== expected.exitCode ||
    (expected.stdoutIncludes !== undefined &&
      !result.stdout.includes(expected.stdoutIncludes)) ||
    (expected.stderrIncludes !== undefined &&
      !result.stderr.includes(expected.stderrIncludes)) ||
    (expected.stderr !== undefined && result.stderr !== expected.stderr)
  ) {
    throw new Error(`${label} smoke check failed`);
  }
};

export const runExecutableSmoke = async (
  binaryInput: string,
): Promise<void> => {
  const binary = resolve(binaryInput);
  const metadata = await stat(binary);
  if ((metadata.mode & 0o111) === 0) {
    throw new Error("Packaged executable is missing its executable bit");
  }

  const { version } = packageManifest.parse(
    await Bun.file(new URL("../package.json", import.meta.url)).json(),
  );
  requireResult(
    await runCommand(binary, []),
    { exitCode: 0, stdoutIncludes: "Usage: asana-cli", stderr: "" },
    "help",
  );
  requireResult(
    await runCommand(binary, ["--version"]),
    { exitCode: 0, stdoutIncludes: `${version}\n`, stderr: "" },
    "version",
  );
  requireResult(
    await runCommand(binary, ["tasks", "get", "invalid"]),
    {
      exitCode: 2,
      stderrIncludes: '"message":"Invalid task identifier"',
    },
    "invalid usage",
  );

  const isolationDirectory = await mkdtemp(`${tmpdir()}/asana-cli-isolation-`);
  try {
    await writeFile(
      `${isolationDirectory}/.env`,
      'ASANA_CLI_TOKEN="dotenv-token-must-not-load"\n',
    );
    await writeFile(
      `${isolationDirectory}/bunfig.toml`,
      'preload = ["./preload.ts"]\n',
    );
    await writeFile(
      `${isolationDirectory}/preload.ts`,
      'process.env.ASANA_CLI_TOKEN = "bunfig-token-must-not-load";\n',
    );
    const sanitizedEnvironment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (
        !["ASANA_CLI_TOKEN", "BUN_OPTIONS", "BUN_BE_BUN"].includes(key) &&
        value !== undefined
      ) {
        sanitizedEnvironment[key] = value;
      }
    }
    requireResult(
      await runCommand(binary, ["whoami"], {
        cwd: isolationDirectory,
        env: sanitizedEnvironment,
      }),
      {
        exitCode: 3,
        stderrIncludes: '"message":"ASANA_CLI_TOKEN is required"',
      },
      "configuration isolation",
    );
  } finally {
    await rm(isolationDirectory, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const binaryIndex = Bun.argv.indexOf("--binary");
  const binary = binaryIndex === -1 ? undefined : Bun.argv[binaryIndex + 1];
  if (binary === undefined) {
    throw new Error("Usage: smoke-executable.ts --binary <path>");
  }
  await runExecutableSmoke(binary);
}

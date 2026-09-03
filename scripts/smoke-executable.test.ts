import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { version } from "../package.json";
import { runExecutableSmoke } from "./smoke-executable.ts";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const createExecutable = async (failedCommand = "") => {
  const directory = await mkdtemp(join(tmpdir(), "asana-smoke-test-"));
  directories.push(directory);
  const binary = join(directory, "cli");
  const log = join(directory, "commands");
  await writeFile(
    binary,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
if [ "$1" = whoami ]; then
  pwd > "${directory}/isolation"
  test -f .env && test -f bunfig.toml && test -f preload.ts || exit 90
  test -z "\${ASANA_CLI_TOKEN+x}" || exit 91
  test -z "\${BUN_OPTIONS+x}" || exit 92
  test -z "\${BUN_BE_BUN+x}" || exit 93
  test "$SMOKE_PRESERVED" = keep || exit 94
fi
if [ "$*" = "${failedCommand}" ]; then exit 99; fi
case "$*" in
  '') printf 'Usage: asana-cli\\n' ;;
  --version) printf '${version}\\n' ;;
  'tasks get invalid') printf '{"message":"Invalid task identifier"}\\n' >&2; exit 2 ;;
  'completion zsh') printf '#compdef asana-cli\\n' ;;
  whoami) printf '{"message":"ASANA_CLI_TOKEN is required"}\\n' >&2; exit 3 ;;
  *) exit 98 ;;
esac
`,
    { mode: 0o755 },
  );
  return { binary, log, directory };
};

test("rejects a binary without executable permission before running commands", async () => {
  const { binary, log } = await createExecutable();
  await chmod(binary, 0o644);
  await expect(runExecutableSmoke(binary)).rejects.toThrow(
    "Packaged executable is missing its executable bit",
  );
  expect(await Bun.file(log).exists()).toBe(false);
});

test.each([
  ["", "help"],
  ["--version", "version"],
  ["tasks get invalid", "invalid usage"],
  ["completion zsh", "shell completion"],
])("rejects a failing core command: %s", async (command, label) => {
  const { binary, directory } = await createExecutable(command);
  await expect(runExecutableSmoke(binary)).rejects.toThrow(
    `${label} smoke check failed`,
  );
  expect(await Bun.file(join(directory, "isolation")).exists()).toBe(false);
});

test.each([false, true])(
  "sanitizes configuration and cleans up isolation (failure: %s)",
  async (fail) => {
    const { binary, log, directory } = await createExecutable(
      fail ? "whoami" : "never",
    );
    const environment = {
      ASANA_CLI_TOKEN: "test-token",
      BUN_OPTIONS: "test-options",
      BUN_BE_BUN: "1",
      SMOKE_PRESERVED: "keep",
    };
    const previous = Object.fromEntries(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, environment);
    try {
      const result = runExecutableSmoke(relative(process.cwd(), binary));
      if (fail) {
        await expect(result).rejects.toThrow(
          "configuration isolation smoke check failed",
        );
      } else {
        await result;
      }
      expect(await readFile(log, "utf8")).toBe(
        "\n--version\ntasks get invalid\ncompletion zsh\nwhoami\n",
      );
      const isolation = await readFile(join(directory, "isolation"), "utf8");
      await expect(stat(isolation.trim())).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

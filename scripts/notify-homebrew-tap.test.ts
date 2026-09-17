import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const runNotifier = async (overrides: Record<string, string> = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "asana-tap-dispatch-test-"));
  temporaryDirectories.push(directory);
  const payloadPath = join(directory, "payload.json");
  const argsPath = join(directory, "args.txt");
  await writeFile(
    join(directory, "gh"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$GH_ARGS_PATH"\ncat > "$GH_PAYLOAD_PATH"\nexit "${GH_EXIT_CODE:-0}"\n',
    { mode: 0o755 },
  );
  const process = Bun.spawn(
    ["bash", join(import.meta.dir, "notify-homebrew-tap.sh")],
    {
      env: {
        ...Bun.env,
        PATH: `${directory}:${Bun.env.PATH ?? ""}`,
        GH_TOKEN: "test-token",
        SOURCE_REPOSITORY: "danielsitek/asana-cli",
        RELEASE_TAG: "v0.6.0",
        GH_ARGS_PATH: argsPath,
        GH_PAYLOAD_PATH: payloadPath,
        ...overrides,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stderr, payloadPath, argsPath };
};

test("dispatches the published release with the tap's payload contract", async () => {
  const result = await runNotifier();
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(await readFile(result.payloadPath, "utf8"))).toEqual({
    event_type: "upstream_release",
    client_payload: {
      repository: "danielsitek/asana-cli",
      tag: "v0.6.0",
    },
  });
  expect(await readFile(result.argsPath, "utf8")).toBe(
    "api\n--method\nPOST\nrepos/danielsitek/homebrew-tap/dispatches\n--input\n-\n",
  );
});

test("fails visibly without a dispatch credential", async () => {
  const result = await runNotifier({ GH_TOKEN: "" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "HOMEBREW_TAP_DISPATCH_TOKEN is not configured",
  );
  expect(await Bun.file(result.payloadPath).exists()).toBe(false);
});

test.each([
  [{ SOURCE_REPOSITORY: "other/asana-cli" }, "Unexpected source repository"],
  [{ RELEASE_TAG: "v0.6.0-rc.1" }, "Unexpected release tag"],
])(
  "rejects an invalid release event before dispatch",
  async (environment, error) => {
    const result = await runNotifier(environment);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(error);
    expect(await Bun.file(result.payloadPath).exists()).toBe(false);
  },
);

test("surfaces an API failure without logging the credential", async () => {
  const result = await runNotifier({ GH_EXIT_CODE: "7" });
  expect(result.exitCode).toBe(7);
  expect(result.stderr).not.toContain("test-token");
});

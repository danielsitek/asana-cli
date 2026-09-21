import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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

const createExecutable = async (
  path: string,
  contents: string,
): Promise<void> => {
  await writeFile(path, contents);
  await chmod(path, 0o755);
};

const runInstaller = async ({
  os = "Darwin",
  architecture = "arm64",
  checksum = Bun.CryptoHasher.hash("sha256", "archive", "hex"),
}: {
  os?: string;
  architecture?: string;
  checksum?: string;
} = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "asana-cli-install-test-"));
  temporaryDirectories.push(directory);
  const binDirectory = join(directory, "bin");
  const installDirectory = join(directory, "installed");
  const curlLog = join(directory, "curl.log");
  await mkdir(binDirectory);

  await createExecutable(
    join(binDirectory, "uname"),
    `#!/usr/bin/env bash
if [[ "$1" == "-s" ]]; then printf '%s\\n' "$TEST_OS"; else printf '%s\\n' "$TEST_ARCH"; fi
`,
  );
  await createExecutable(
    join(binDirectory, "curl"),
    `#!/usr/bin/env bash
output=""
url=""
while (( $# > 0 )); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --header) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$TEST_CURL_LOG"
case "$url" in
  https://api.github.com/*) printf '{"tag_name":"v1.2.3"}' ;;
  */SHA256SUMS) printf '%s  %s\\n' "$TEST_CHECKSUM" "$TEST_ARCHIVE_NAME" > "$output" ;;
  *) printf 'archive' > "$output" ;;
esac
`,
  );
  await createExecutable(
    join(binDirectory, "tar"),
    `#!/usr/bin/env bash
while (( $# > 0 )); do
  if [[ "$1" == "-C" ]]; then directory="$2"; break; fi
  shift
done
cat > "$directory/asana-cli" <<'SCRIPT'
#!/usr/bin/env bash
printf '1.2.3\\n'
SCRIPT
chmod 0755 "$directory/asana-cli"
`,
  );

  const targetByPlatform: Record<string, string> = {
    "Darwin:arm64": "darwin-arm64",
    "Darwin:x86_64": "darwin-x64",
    "Linux:x86_64": "linux-x64-baseline",
    "Linux:aarch64": "linux-arm64",
  };
  const target = targetByPlatform[`${os}:${architecture}`];
  const archiveName = `asana-cli-v1.2.3-${target}.tar.gz`;
  const process = Bun.spawn(
    ["bash", join(import.meta.dir, "..", "install.sh")],
    {
      env: {
        ...Bun.env,
        PATH: `${binDirectory}:${Bun.env.PATH ?? ""}`,
        ASANA_CLI_INSTALL_DIR: installDirectory,
        TEST_OS: os,
        TEST_ARCH: architecture,
        TEST_CHECKSUM: checksum,
        TEST_ARCHIVE_NAME: archiveName,
        TEST_CURL_LOG: curlLog,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return {
    exitCode,
    stdout,
    stderr,
    installDirectory,
    curlLog,
  };
};

describe("install script", () => {
  test.each([
    ["Darwin", "arm64", "darwin-arm64"],
    ["Darwin", "x86_64", "darwin-x64"],
    ["Linux", "x86_64", "linux-x64-baseline"],
    ["Linux", "aarch64", "linux-arm64"],
  ])(
    "installs the pinned release for %s/%s",
    async (os, architecture, target) => {
      const result = await runInstaller({ os, architecture });
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(result.stdout).toContain("Installed asana-cli 1.2.3");
      expect(await readFile(result.curlLog, "utf8")).toContain(
        `https://github.com/danielsitek/asana-cli/releases/download/v1.2.3/asana-cli-v1.2.3-${target}.tar.gz`,
      );
      expect(
        await readFile(join(result.installDirectory, "asana-cli"), "utf8"),
      ).toContain("1.2.3");
    },
  );

  test("aborts before installation when the checksum does not match", async () => {
    const result = await runInstaller({ checksum: "0".repeat(64) });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/FAILED|did NOT match/);
    expect(
      await Bun.file(join(result.installDirectory, "asana-cli")).exists(),
    ).toBe(false);
  });
});

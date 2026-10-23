import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("Codacy duplication excludes every test file by its full path", async () => {
  const root = join(import.meta.dir, "..");
  const source = await readFile(join(root, ".codacy.yml"), "utf8");
  const config = Bun.YAML.parse(source) as {
    exclude_paths?: unknown;
    engines?: { duplication?: { exclude_paths?: unknown } };
  };
  const paths: string[] = [];

  for (const directory of ["scripts", "src", "test"]) {
    const glob = new Bun.Glob("**/*.test.ts");
    for await (const path of glob.scan({ cwd: join(root, directory) })) {
      paths.push(`${directory}/${path}`);
    }
  }

  expect(config.exclude_paths).toBeUndefined();
  expect(config.engines?.duplication?.exclude_paths).toEqual(paths.sort());
});

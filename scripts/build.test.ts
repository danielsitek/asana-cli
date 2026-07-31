import { describe, expect, test } from "bun:test";

import { releaseTargets, runBuild } from "./build.ts";

describe("release build interface", () => {
  test("keeps the default host output and compile isolation", async () => {
    const configs: Bun.BuildConfig[] = [];
    const outputs = await runBuild([], (config) => {
      configs.push(config);
      return { success: true, logs: [] };
    });
    expect(outputs).toEqual(["dist/asana-cli"]);
    expect(configs[0]).toMatchObject({
      minify: true,
      sourcemap: "inline",
      compile: {
        outfile: "dist/asana-cli",
        autoloadDotenv: false,
        autoloadBunfig: false,
      },
      define: { __APP_VERSION__: JSON.stringify("0.1.0") },
    });
    expect(configs[0]).not.toHaveProperty("bytecode");
  });

  test("builds one exact release target", async () => {
    const configs: Bun.BuildConfig[] = [];
    const outputs = await runBuild(["--target", "darwin-arm64"], (config) => {
      configs.push(config);
      return { success: true, logs: [] };
    });
    expect(outputs).toEqual(["dist/release/darwin-arm64/asana-cli"]);
    expect(configs[0]?.compile).toMatchObject({
      target: "bun-darwin-arm64",
      outfile: "dist/release/darwin-arm64/asana-cli",
    });
  });

  test("builds all release targets once", async () => {
    const configs: Bun.BuildConfig[] = [];
    const outputs = await runBuild(["--all"], (config) => {
      configs.push(config);
      return { success: true, logs: [] };
    });
    expect(outputs).toEqual(
      Object.keys(releaseTargets).map(
        (target) => `dist/release/${target}/asana-cli`,
      ),
    );
    expect(
      configs.map((config) =>
        typeof config.compile === "object" ? config.compile.target : undefined,
      ),
    ).toEqual(Object.values(releaseTargets));
  });

  test("rejects invalid targets before building", async () => {
    let calls = 0;
    await expect(
      runBuild(["--target", "windows-x64"], () => {
        calls += 1;
        return { success: true, logs: [] };
      }),
    ).rejects.toThrow("Unknown release target: windows-x64");
    expect(calls).toBe(0);
  });

  test("fails loudly when Bun compilation fails", async () => {
    await expect(
      runBuild(["--target", "linux-arm64"], () => ({
        success: false,
        logs: [new Error("compiler failure")],
      })),
    ).rejects.toThrow("Failed to build linux-arm64");
  });
});

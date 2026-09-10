import { describe, expect, test } from "bun:test";

import {
  checkForUpdate,
  renderUpdateNotice,
  UPDATE_CHECK_INTERVAL_MS,
} from "./index.ts";

const cacheDirectory = "/cache/asana-cli";
const cachePath = `${cacheDirectory}/update-check.json`;

describe("update check", () => {
  test("returns a newer release from a fresh cache without fetching", async () => {
    let fetched = false;
    const notice = await checkForUpdate({
      currentVersion: "0.5.0",
      cacheDirectory,
      now: () => UPDATE_CHECK_INTERVAL_MS,
      readFile: async (path) => {
        expect(path).toBe(cachePath);
        return JSON.stringify({
          checkedAt: 1,
          latestVersion: "0.6.0",
          releaseUrl:
            "https://github.com/danielsitek/asana-cli/releases/tag/v0.6.0",
        });
      },
      fetch: async () => {
        fetched = true;
        throw new Error("unexpected fetch");
      },
    });

    expect(fetched).toBe(false);
    expect(notice).toEqual({
      currentVersion: "0.5.0",
      latestVersion: "0.6.0",
      releaseUrl:
        "https://github.com/danielsitek/asana-cli/releases/tag/v0.6.0",
    });
  });

  test("fetches and caches the latest GitHub release after the interval", async () => {
    let writtenPath = "";
    let writtenContents = "";
    let requestedUrl = "";
    const notice = await checkForUpdate({
      currentVersion: "0.5.0",
      cacheDirectory,
      now: () => UPDATE_CHECK_INTERVAL_MS + 2,
      readFile: async () =>
        JSON.stringify({
          checkedAt: 1,
          latestVersion: "0.5.0",
          releaseUrl: "https://example.com/old",
        }),
      mkdir: async (path, options) => {
        expect(path).toBe(cacheDirectory);
        expect(options).toEqual({ recursive: true });
      },
      writeFile: async (path, contents) => {
        writtenPath = path;
        writtenContents = contents;
      },
      fetch: async (input) => {
        requestedUrl = input.toString();
        return new Response(
          JSON.stringify({
            tag_name: "v1.0.0",
            html_url:
              "https://github.com/danielsitek/asana-cli/releases/tag/v1.0.0",
          }),
        );
      },
    });

    expect(requestedUrl).toBe(
      "https://api.github.com/repos/danielsitek/asana-cli/releases/latest",
    );
    expect(writtenPath).toBe(cachePath);
    expect(JSON.parse(writtenContents)).toEqual({
      checkedAt: UPDATE_CHECK_INTERVAL_MS + 2,
      latestVersion: "1.0.0",
      releaseUrl:
        "https://github.com/danielsitek/asana-cli/releases/tag/v1.0.0",
    });
    expect(notice?.latestVersion).toBe("1.0.0");
  });

  test("does not notify for equal, older, or malformed versions", async () => {
    for (const latestVersion of ["0.5.0", "0.4.9", "next"]) {
      expect(
        await checkForUpdate({
          currentVersion: "0.5.0",
          cacheDirectory,
          now: () => 10,
          readFile: async () =>
            JSON.stringify({
              checkedAt: 10,
              latestVersion,
              releaseUrl: "https://example.com/release",
            }),
        }),
      ).toBeUndefined();
    }
  });

  test("silently ignores network, response, and cache write failures", async () => {
    expect(
      await checkForUpdate({
        currentVersion: "0.5.0",
        cacheDirectory,
        readFile: async () => {
          throw new Error("missing");
        },
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    ).toBeUndefined();

    const notice = await checkForUpdate({
      currentVersion: "0.5.0",
      cacheDirectory,
      readFile: async () => "invalid json",
      mkdir: async () => {
        throw new Error("read-only filesystem");
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            tag_name: "v0.6.0",
            html_url: "https://example.com/release",
          }),
        ),
    });
    expect(notice?.latestVersion).toBe("0.6.0");
  });

  test("renders an actionable stderr notice", () => {
    expect(
      renderUpdateNotice({
        currentVersion: "0.5.0",
        latestVersion: "0.6.0",
        releaseUrl: "https://example.com/release",
      }),
    ).toBe(
      "\nUpdate available: 0.5.0 → 0.6.0\n" +
        "Run `brew upgrade asana-cli` or visit https://example.com/release\n",
    );
  });
});

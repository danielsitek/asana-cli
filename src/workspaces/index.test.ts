import { describe, expect, test } from "bun:test";

import { err, ok, type Result } from "../shared/result.ts";
import {
  executeWorkspacesList,
  type Workspace,
  type WorkspaceGateway,
  type WorkspaceListError,
} from "./index.ts";

class QueuedReader implements WorkspaceGateway {
  calls: Array<Readonly<{ limit: number; offset?: string }>> = [];

  constructor(
    private readonly pages: readonly Result<
      Readonly<{ workspaces: readonly Workspace[]; nextOffset?: string }>,
      WorkspaceListError
    >[],
  ) {}

  async listWorkspaces(
    _token: string,
    options: Readonly<{ limit: number; offset?: string }>,
  ) {
    this.calls.push(options);
    const page = this.pages[this.calls.length - 1];
    if (!page) throw new Error("no more pages queued");
    return page;
  }
}

const workspace = (index: number): Workspace => ({
  gid: `${index}`,
  name: `Workspace ${index}`,
});

describe("executeWorkspacesList", () => {
  test("returns a single page in API order", async () => {
    const reader = new QueuedReader([
      ok({ workspaces: [workspace(1), workspace(2)] }),
    ]);
    const result = await executeWorkspacesList("t", { reader });
    expect(result).toEqual({
      ok: true,
      value: [workspace(1), workspace(2)],
    });
    expect(reader.calls).toEqual([{ limit: 100 }]);
  });

  test("paginates across pages exactly once each, combined in API order", async () => {
    const reader = new QueuedReader([
      ok({ workspaces: [workspace(1)], nextOffset: "page-2" }),
      ok({ workspaces: [workspace(2)] }),
    ]);
    const result = await executeWorkspacesList("t", { reader });
    expect(result).toEqual({
      ok: true,
      value: [workspace(1), workspace(2)],
    });
    expect(reader.calls).toEqual([
      { limit: 100 },
      { limit: 100, offset: "page-2" },
    ]);
  });

  test("treats an empty terminal page as source exhaustion", async () => {
    const reader = new QueuedReader([ok({ workspaces: [] })]);
    const result = await executeWorkspacesList("t", { reader });
    expect(result).toEqual({ ok: true, value: [] });
    expect(reader.calls).toHaveLength(1);
  });

  test("rejects an empty page that claims a next offset", async () => {
    const reader = new QueuedReader([
      ok({ workspaces: [], nextOffset: "unique-next-page" }),
    ]);
    const result = await executeWorkspacesList("t", { reader });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Workspace pagination did not advance",
      },
    });
    expect(reader.calls).toHaveLength(1);
  });

  test("rejects an offset that a page returns as its own next offset", async () => {
    const reader = new QueuedReader([
      ok({ workspaces: [workspace(1)], nextOffset: "page-2" }),
      ok({ workspaces: [workspace(2)], nextOffset: "page-2" }),
    ]);
    const result = await executeWorkspacesList("t", { reader });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Workspace pagination did not advance",
      },
    });
    expect(reader.calls).toEqual([
      { limit: 100 },
      { limit: 100, offset: "page-2" },
    ]);
  });

  test("rejects an offset cycle across multiple pages", async () => {
    const reader = new QueuedReader([
      ok({ workspaces: [workspace(1)], nextOffset: "page-2" }),
      ok({ workspaces: [workspace(2)], nextOffset: "page-3" }),
      ok({ workspaces: [workspace(3)], nextOffset: "page-2" }),
    ]);
    const result = await executeWorkspacesList("t", { reader });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_response",
        message: "Workspace pagination did not advance",
      },
    });
    expect(reader.calls).toEqual([
      { limit: 100 },
      { limit: 100, offset: "page-2" },
      { limit: 100, offset: "page-3" },
    ]);
  });

  test("propagates a reader error without further requests", async () => {
    const reader = new QueuedReader([
      err({ kind: "authentication", message: "denied" }),
    ]);
    const result = await executeWorkspacesList("t", { reader });
    expect(result).toEqual({
      ok: false,
      error: { kind: "authentication", message: "denied" },
    });
    expect(reader.calls).toHaveLength(1);
  });
});

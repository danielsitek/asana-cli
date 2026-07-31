import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DiscoveredMyTasks,
  MyTasksDiscoveryGateway,
} from "../config/index.ts";
import { err, ok } from "../shared/result.ts";
import type { TaskGateway } from "../tasks/index.ts";
import {
  createMyTasksMutationResolver,
  type MyTasksMutationDependencies,
} from "./index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const discoveredMyTasks = (
  overrides: Partial<DiscoveredMyTasks> = {},
): DiscoveredMyTasks => ({
  userTaskListGid: "200",
  sections: [{ gid: "300", name: "In Review" }],
  customFields: [
    {
      gid: "400",
      name: "Estimate",
      resourceSubtype: "number",
      isReadOnly: false,
    },
    {
      gid: "500",
      name: "Cost",
      resourceSubtype: "number",
      isReadOnly: false,
    },
  ],
  ...overrides,
});

const setup = async (
  overrides: Partial<MyTasksMutationDependencies> = {},
  myTasks: Record<string, unknown> = {
    userTaskListGid: "200",
    sections: { in_review: "300" },
    customFields: { estimate: "400", cost: "500" },
  },
) => {
  const root = await mkdtemp(join(tmpdir(), "asana-cli-my-tasks-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, ".git"));
  await writeFile(
    join(root, ".asana-cli.json"),
    JSON.stringify({ workspace: { gid: "100" } }),
  );
  await writeFile(
    join(root, ".asana-cli.local.json"),
    JSON.stringify({ myTasks }),
  );
  const calls = { discovery: 0, identity: 0, reader: 0 };
  const discovery: MyTasksDiscoveryGateway = {
    discoverMyTasks: async (token, workspaceGid) => {
      calls.discovery += 1;
      expect({ token, workspaceGid }).toEqual({
        token: "secret",
        workspaceGid: "100",
      });
      return ok(discoveredMyTasks());
    },
  };
  const reader: TaskGateway = {
    getTask: async (token, taskId, fields) => {
      calls.reader += 1;
      expect({ token, taskId, fields }).toEqual({
        token: "secret",
        taskId: "123",
        fields: ["assignee.gid"],
      });
      return ok({ assignee: { gid: "9001" } });
    },
  };
  return {
    calls,
    resolver: createMyTasksMutationResolver({
      configuration: { cwd: root, home: join(root, "home"), environment: {} },
      discovery,
      reader,
      resolveAuthenticatedUserGid: async () => {
        calls.identity += 1;
        return ok("9001");
      },
      ...overrides,
    }),
  };
};

describe("My Tasks mutation resolution", () => {
  test("resolves aliases and validates all reads before returning a mutation", async () => {
    const { resolver, calls } = await setup();
    const result = await resolver.resolve({
      token: "secret",
      taskId: "123",
      mySection: { kind: "alias", value: "in_review" },
      customFields: [
        { field: { kind: "gid", value: "500" }, value: 2.5 },
        { field: { kind: "alias", value: "estimate" }, value: null },
      ],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        assignee_section: "300",
        custom_fields: { "400": null, "500": 2.5 },
      },
    });
    expect(calls).toEqual({ discovery: 1, identity: 1, reader: 1 });
  });

  test("uses a known authenticated final assignee without identity or task reads", async () => {
    const { resolver, calls } = await setup();
    const result = await resolver.resolve({
      token: "secret",
      taskId: "123",
      finalAssignee: "9001",
      authenticatedUserGid: "9001",
      mySection: { kind: "gid", value: "300" },
      customFields: [],
    });

    expect(result).toEqual({
      ok: true,
      value: { assignee_section: "300" },
    });
    expect(calls).toEqual({ discovery: 1, identity: 0, reader: 0 });
  });

  test.each([
    [
      "missing section alias",
      { mySection: { kind: "alias", value: "missing" }, customFields: [] },
      {},
      "is not configured",
    ],
    [
      "missing field alias",
      {
        customFields: [
          { field: { kind: "alias", value: "missing" }, value: 1 },
        ],
      },
      {},
      "is not configured",
    ],
    [
      "stale task list",
      { mySection: { kind: "gid", value: "300" }, customFields: [] },
      { discovered: discoveredMyTasks({ userTaskListGid: "201" }) },
      "does not match",
    ],
    [
      "section outside My Tasks",
      { mySection: { kind: "gid", value: "301" }, customFields: [] },
      {},
      "is not present",
    ],
    [
      "field outside My Tasks",
      {
        customFields: [{ field: { kind: "gid", value: "401" }, value: 1 }],
      },
      {},
      "is not present",
    ],
    [
      "wrong field type",
      {
        customFields: [{ field: { kind: "gid", value: "400" }, value: 1 }],
      },
      {
        discovered: discoveredMyTasks({
          customFields: [
            {
              gid: "400",
              name: "Estimate",
              resourceSubtype: "text",
              isReadOnly: false,
            },
          ],
        }),
      },
      "is not a number field",
    ],
    [
      "read-only field",
      {
        customFields: [{ field: { kind: "gid", value: "400" }, value: 1 }],
      },
      {
        discovered: discoveredMyTasks({
          customFields: [
            {
              gid: "400",
              name: "Estimate",
              resourceSubtype: "number",
              isReadOnly: true,
            },
          ],
        }),
      },
      "is read-only",
    ],
  ] as const)("rejects %s", async (_, request, setupOptions, message) => {
    const discovery = new (class implements MyTasksDiscoveryGateway {
      async discoverMyTasks() {
        return ok(
          "discovered" in setupOptions
            ? setupOptions.discovered
            : discoveredMyTasks(),
        );
      }
    })();
    const { resolver } = await setup({ discovery });
    const result = await resolver.resolve({
      token: "secret",
      taskId: "123",
      ...request,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(message);
  });

  test("rejects aliases resolving to one field and assignee mismatches", async () => {
    const { resolver } = await setup();
    const duplicate = await resolver.resolve({
      token: "secret",
      taskId: "123",
      finalAssignee: "9001",
      authenticatedUserGid: "9001",
      customFields: [
        { field: { kind: "alias", value: "estimate" }, value: 1 },
        { field: { kind: "gid", value: "400" }, value: 2 },
      ],
    });
    const mismatch = await resolver.resolve({
      token: "secret",
      taskId: "123",
      finalAssignee: "9002",
      authenticatedUserGid: "9001",
      mySection: { kind: "gid", value: "300" },
      customFields: [],
    });

    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.message).toContain("same field");
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok)
      expect(mismatch.error.message).toContain("final assignee");
  });

  test("propagates discovery and current-task read failures", async () => {
    const discoveryFailure = await setup({
      discovery: {
        discoverMyTasks: async () =>
          err({ kind: "network", message: "offline" }),
      },
    });
    const readFailure = await setup({
      reader: {
        getTask: async () => err({ kind: "not_found", message: "missing" }),
      },
    });
    const request = {
      token: "secret",
      taskId: "123",
      mySection: { kind: "gid" as const, value: "300" },
      customFields: [],
    };

    expect((await discoveryFailure.resolver.resolve(request)).ok).toBe(false);
    expect((await readFailure.resolver.resolve(request)).ok).toBe(false);
  });
});

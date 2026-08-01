import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DiscoveredMyTasks,
  MyTaskSectionsDiscoveryGateway,
  MyTasksDiscoveryGateway,
} from "../config/index.ts";
import { err, ok } from "../shared/result.ts";
import type { TaskGateway } from "../tasks/index.ts";
import {
  createMySectionResolver,
  createMyTasksMutationResolver,
  type MySectionResolverDependencies,
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
    {
      gid: "600",
      name: "Priority",
      resourceSubtype: "enum",
      isReadOnly: false,
      enumOptions: [
        { gid: "601", name: "Low", enabled: true },
        { gid: "602", name: "High", enabled: true },
        { gid: "603", name: "Archived", enabled: false },
        { gid: "604", name: "603", enabled: true },
      ],
    },
  ],
  ...overrides,
});

const setup = async (
  overrides: Partial<MyTasksMutationDependencies> = {},
  myTasks: Record<string, unknown> = {
    userTaskListGid: "200",
    sections: { in_review: "300" },
    customFields: { estimate: "400", cost: "500", priority: "600" },
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
        { field: { kind: "gid", value: "500" }, value: "2.5" },
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

  test("resolves enum fields by option GID and by exact name", async () => {
    const { resolver } = await setup();
    const byGid = await resolver.resolve({
      token: "secret",
      taskId: "123",
      finalAssignee: "9001",
      authenticatedUserGid: "9001",
      customFields: [{ field: { kind: "gid", value: "600" }, value: "601" }],
    });
    const byName = await resolver.resolve({
      token: "secret",
      taskId: "123",
      finalAssignee: "9001",
      authenticatedUserGid: "9001",
      customFields: [
        { field: { kind: "alias", value: "priority" }, value: "High" },
      ],
    });
    const byNull = await resolver.resolve({
      token: "secret",
      taskId: "123",
      finalAssignee: "9001",
      authenticatedUserGid: "9001",
      customFields: [{ field: { kind: "gid", value: "600" }, value: null }],
    });

    expect(byGid).toEqual({
      ok: true,
      value: { custom_fields: { "600": "601" } },
    });
    expect(byName).toEqual({
      ok: true,
      value: { custom_fields: { "600": "602" } },
    });
    expect(byNull).toEqual({
      ok: true,
      value: { custom_fields: { "600": null } },
    });
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
          { field: { kind: "alias", value: "missing" }, value: "1" },
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
        customFields: [{ field: { kind: "gid", value: "401" }, value: "1" }],
      },
      {},
      "is not present",
    ],
    [
      "unsupported field subtype",
      {
        customFields: [{ field: { kind: "gid", value: "400" }, value: "1" }],
      },
      {
        discovered: discoveredMyTasks({
          customFields: [
            {
              gid: "400",
              name: "Estimate",
              resourceSubtype: "unsupported",
              originalResourceSubtype: "text",
              isReadOnly: false,
            },
          ],
        }),
      },
      "is not a number or enum field",
    ],
    [
      "read-only field",
      {
        customFields: [{ field: { kind: "gid", value: "400" }, value: "1" }],
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
    [
      "malformed numeric value",
      {
        customFields: [{ field: { kind: "gid", value: "400" }, value: "1e3" }],
      },
      {},
      "must be an integer, dot-decimal, or null",
    ],
    [
      "disabled enum option by GID",
      {
        customFields: [{ field: { kind: "gid", value: "600" }, value: "603" }],
      },
      {},
      "is disabled",
    ],
    [
      "disabled enum option by name",
      {
        customFields: [
          { field: { kind: "gid", value: "600" }, value: "Archived" },
        ],
      },
      {},
      "is unknown",
    ],
    [
      "unknown enum option",
      {
        customFields: [
          { field: { kind: "gid", value: "600" }, value: "Medium" },
        ],
      },
      {},
      "is unknown",
    ],
    [
      "ambiguous enum option name",
      {
        customFields: [{ field: { kind: "gid", value: "600" }, value: "Low" }],
      },
      {
        discovered: discoveredMyTasks({
          customFields: [
            {
              gid: "600",
              name: "Priority",
              resourceSubtype: "enum",
              isReadOnly: false,
              enumOptions: [
                { gid: "601", name: "Low", enabled: true },
                { gid: "604", name: "Low", enabled: true },
              ],
            },
          ],
        }),
      },
      "is ambiguous",
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

  test("lists valid enum option names once each, sorted deterministically", async () => {
    const discovery = new (class implements MyTasksDiscoveryGateway {
      async discoverMyTasks() {
        return ok(
          discoveredMyTasks({
            customFields: [
              {
                gid: "600",
                name: "Priority",
                resourceSubtype: "enum",
                isReadOnly: false,
                enumOptions: [
                  { gid: "601", name: "Low", enabled: true },
                  { gid: "604", name: "Low", enabled: true },
                  { gid: "602", name: "High", enabled: true },
                ],
              },
            ],
          }),
        );
      }
    })();
    const { resolver } = await setup({ discovery });
    const result = await resolver.resolve({
      token: "secret",
      taskId: "123",
      customFields: [{ field: { kind: "gid", value: "600" }, value: "Medium" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("valid options: High, Low");
      expect(result.error.message).not.toContain("Low, Low");
    }
  });

  test("rejects aliases resolving to one field and assignee mismatches", async () => {
    const { resolver } = await setup();
    const duplicate = await resolver.resolve({
      token: "secret",
      taskId: "123",
      finalAssignee: "9001",
      authenticatedUserGid: "9001",
      customFields: [
        { field: { kind: "alias", value: "estimate" }, value: "1" },
        { field: { kind: "gid", value: "400" }, value: "2" },
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

const setupSectionResolver = async (
  overrides: Partial<MySectionResolverDependencies> = {},
  myTasks: Record<string, unknown> = {
    userTaskListGid: "200",
    sections: { in_review: "300" },
  },
) => {
  const root = await mkdtemp(join(tmpdir(), "asana-cli-my-section-"));
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
  const calls = { discovery: 0 };
  const discovery: MyTaskSectionsDiscoveryGateway = {
    discoverMyTaskSections: async (token, workspaceGid) => {
      calls.discovery += 1;
      expect({ token, workspaceGid }).toEqual({
        token: "secret",
        workspaceGid: "100",
      });
      const { userTaskListGid, sections } = discoveredMyTasks();
      return ok({ userTaskListGid, sections });
    },
  };
  return {
    calls,
    resolver: createMySectionResolver({
      configuration: { cwd: root, home: join(root, "home"), environment: {} },
      discovery,
      ...overrides,
    }),
  };
};

describe("My Tasks section resolution", () => {
  test("resolves an alias to its section GID after validating discovery", async () => {
    const { resolver, calls } = await setupSectionResolver();
    const result = await resolver.resolve("secret", {
      kind: "alias",
      value: "in_review",
    });
    expect(result).toEqual({ ok: true, value: { sectionGid: "300" } });
    expect(calls.discovery).toBe(1);
  });

  test("resolves a raw GID without an alias lookup", async () => {
    const { resolver } = await setupSectionResolver();
    const result = await resolver.resolve("secret", {
      kind: "gid",
      value: "300",
    });
    expect(result).toEqual({ ok: true, value: { sectionGid: "300" } });
  });

  test("rejects an unknown alias", async () => {
    const { resolver } = await setupSectionResolver();
    const result = await resolver.resolve("secret", {
      kind: "alias",
      value: "missing",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("is not configured");
    }
  });

  test("rejects a section GID absent from the live My Tasks list", async () => {
    const { resolver } = await setupSectionResolver();
    const result = await resolver.resolve("secret", {
      kind: "gid",
      value: "999",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("is not present");
  });

  test("rejects a stale configured user task list", async () => {
    const discovery: MyTaskSectionsDiscoveryGateway = {
      discoverMyTaskSections: async () => {
        const { userTaskListGid, sections } = discoveredMyTasks({
          userTaskListGid: "201",
        });
        return ok({ userTaskListGid, sections });
      },
    };
    const { resolver } = await setupSectionResolver({ discovery });
    const result = await resolver.resolve("secret", {
      kind: "gid",
      value: "300",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("does not match");
  });

  test("requires configured workspace and user task list before discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "asana-cli-my-section-empty-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".git"));
    let discoveryCalls = 0;
    const resolver = createMySectionResolver({
      configuration: { cwd: root, home: join(root, "home"), environment: {} },
      discovery: {
        discoverMyTaskSections: async () => {
          discoveryCalls += 1;
          const { userTaskListGid, sections } = discoveredMyTasks();
          return ok({ userTaskListGid, sections });
        },
      },
    });
    const result = await resolver.resolve("secret", {
      kind: "gid",
      value: "300",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("workspace.gid");
    expect(discoveryCalls).toBe(0);
  });

  test("propagates discovery failures", async () => {
    const discovery: MyTaskSectionsDiscoveryGateway = {
      discoverMyTaskSections: async () =>
        err({ kind: "network", message: "offline" }),
    };
    const { resolver } = await setupSectionResolver({ discovery });
    const result = await resolver.resolve("secret", {
      kind: "gid",
      value: "300",
    });
    expect(result.ok).toBe(false);
  });
});

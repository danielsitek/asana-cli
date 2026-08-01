import { describe, expect, test } from "bun:test";

import { projectFields } from "./project-fields.ts";

describe("projectFields", () => {
  test("merges object paths and removes unselected fields", () => {
    expect(
      projectFields(
        {
          gid: "1",
          assignee: { gid: "2", name: "Ada", email: "ada@example.com" },
          notes: "hidden",
        },
        ["gid", "assignee.gid", "assignee.name"],
      ),
    ).toEqual({
      found: true,
      value: { gid: "1", assignee: { gid: "2", name: "Ada" } },
    });
  });

  test("projects paths through arrays while preserving collection shape", () => {
    expect(
      projectFields(
        {
          memberships: [
            {
              project: { gid: "10", name: "Alpha" },
              section: { gid: "20", name: "Doing" },
            },
            {
              project: { gid: "11", name: "Beta" },
              section: null,
            },
          ],
        },
        ["memberships.project.name", "memberships.section.name"],
      ),
    ).toEqual({
      found: true,
      value: {
        memberships: [
          { project: { name: "Alpha" }, section: { name: "Doing" } },
          { project: { name: "Beta" }, section: null },
        ],
      },
    });
  });

  test("accepts empty arrays and nullable paths", () => {
    expect(
      projectFields({ projects: [], assignee: null }, [
        "projects.name",
        "assignee.gid",
      ]),
    ).toEqual({
      found: true,
      value: { projects: [], assignee: null },
    });
  });

  test("reports a missing object or array-element path", () => {
    expect(
      projectFields({ assignee: { name: "Ada" } }, ["assignee.gid"]),
    ).toEqual({ found: false });
    expect(
      projectFields(
        { memberships: [{ project: { name: "Alpha" } }, { project: {} }] },
        ["memberships.project.name"],
      ),
    ).toEqual({ found: false });
  });

  test("selecting a parent keeps its full value", () => {
    expect(
      projectFields({ assignee: { gid: "2", name: "Ada" } }, [
        "assignee",
        "assignee.gid",
      ]),
    ).toEqual({
      found: true,
      value: { assignee: { gid: "2", name: "Ada" } },
    });
  });
});

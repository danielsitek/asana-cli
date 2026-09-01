import type { IdentityError } from "../identity/index.ts";
import { err, ok, type Result } from "../shared/result.ts";

export type Project = Readonly<{
  gid?: string;
  name?: string;
  archived?: boolean;
  [key: string]: unknown;
}>;

export type ProjectListItem = Project & Readonly<{ gid: string; name: string }>;

export type ProjectSection = Readonly<{
  gid?: string;
  name?: string;
  [key: string]: unknown;
}>;

export type ProjectReadError = Readonly<{
  kind:
    | "authentication"
    | "api"
    | "not_found"
    | "rate_limit"
    | "network"
    | "invalid_response";
  message: string;
  status?: number;
}>;

export type ProjectListError = IdentityError;

export type ProjectListPage = Readonly<{
  projects: readonly ProjectListItem[];
  nextOffset?: string;
}>;

export interface ProjectGateway {
  listProjects(
    token: string,
    workspaceGid: string,
    options: Readonly<{ limit: number; offset?: string }>,
  ): Promise<Result<ProjectListPage, ProjectListError>>;
}

export interface ProjectReadGateway {
  getProject(
    request: Readonly<{
      token: string;
      projectGid: string;
      fields: readonly string[];
    }>,
  ): Promise<Result<Project, ProjectReadError>>;
}

export type ProjectSectionPage = Readonly<{
  sections: readonly ProjectSection[];
  nextOffset?: string;
}>;

export interface ProjectSectionGateway {
  listProjectSections(
    request: Readonly<{
      token: string;
      projectGid: string;
      limit: number;
      offset?: string;
      fields: readonly string[];
    }>,
  ): Promise<Result<ProjectSectionPage, ProjectReadError>>;
}

export const DEFAULT_PROJECT_FIELDS = ["gid", "name", "archived"] as const;
export const DEFAULT_PROJECT_SECTION_FIELDS = ["gid", "name"] as const;

export const parseProjectGid = (
  input: string,
): Result<string, Readonly<{ kind: "invalid_usage"; message: string }>> =>
  /^\d+$/.test(input)
    ? ok(input)
    : err({
        kind: "invalid_usage",
        message: "Invalid project identifier",
      });

export type ProjectListOptions = Readonly<{
  workspace?: string;
  max?: string;
  all?: boolean;
}>;

export type PreparedProjectList = Readonly<{
  workspaceGid: string;
  scanCap: number;
  resultCap?: number;
}>;

export type ProjectListMeta = Readonly<{
  scanned: number;
  returned: number;
  scan_truncated: boolean;
  next_offset?: string;
}>;

const DEFAULT_SCAN_CAP = 100;
const DEFAULT_RESULT_CAP = 20;

const parseMax = (
  input: string,
): Result<number, Readonly<{ kind: "invalid_usage"; message: string }>> => {
  if (!/^\d+$/.test(input)) {
    return err({
      kind: "invalid_usage",
      message: "--max must be a positive safe integer",
    });
  }
  const value = Number(input);
  return Number.isSafeInteger(value) && value > 0
    ? ok(value)
    : err({
        kind: "invalid_usage",
        message: "--max must be a positive safe integer",
      });
};

type BoundedListOptions = Readonly<{ max?: string; all?: boolean }>;
type PreparedBoundedList = Readonly<{ scanCap: number; resultCap?: number }>;

const prepareBoundedList = (
  options: BoundedListOptions,
): Result<
  PreparedBoundedList,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  if (options.all && options.max === undefined) {
    return err({ kind: "invalid_usage", message: "--all requires --max" });
  }
  const scanCap =
    options.max === undefined ? ok(DEFAULT_SCAN_CAP) : parseMax(options.max);
  if (!scanCap.ok) return scanCap;
  return ok({
    scanCap: scanCap.value,
    ...(options.all ? {} : { resultCap: DEFAULT_RESULT_CAP }),
  });
};

export type ProjectSectionListOptions = Readonly<{
  projectGid: string;
  max?: string;
  all?: boolean;
  fields: readonly string[];
}>;

export type PreparedProjectSectionList = Readonly<{
  projectGid: string;
  scanCap: number;
  resultCap?: number;
  fields: readonly string[];
}>;

export const prepareProjectSectionList = (
  options: ProjectSectionListOptions,
): Result<
  PreparedProjectSectionList,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  const projectGid = parseProjectGid(options.projectGid);
  if (!projectGid.ok) return projectGid;
  const bounded = prepareBoundedList(options);
  if (!bounded.ok) return bounded;
  return ok({
    projectGid: projectGid.value,
    ...bounded.value,
    fields: options.fields,
  });
};

export const prepareProjectList = (
  options: ProjectListOptions,
  configuredWorkspaceGid?: string,
): Result<
  PreparedProjectList,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  const workspaceGid = options.workspace ?? configuredWorkspaceGid;
  if (workspaceGid === undefined) {
    return err({
      kind: "invalid_usage",
      message:
        "projects list requires --workspace or a configured workspace.gid",
    });
  }
  if (!/^\d+$/.test(workspaceGid)) {
    return err({
      kind: "invalid_usage",
      message: "--workspace must be a digit-only GID",
    });
  }
  const bounded = prepareBoundedList(options);
  return bounded.ok ? ok({ workspaceGid, ...bounded.value }) : bounded;
};

type BoundedPage<Item> = Readonly<{
  items: readonly Item[];
  nextOffset?: string;
}>;

const executeBoundedPages = async <Item, Error>(
  prepared: PreparedBoundedList,
  readPage: (
    limit: number,
    offset?: string,
  ) => Promise<Result<BoundedPage<Item>, Error>>,
  paginationError: Error,
): Promise<
  Result<Readonly<{ items: readonly Item[]; meta: ProjectListMeta }>, Error>
> => {
  const items: Item[] = [];
  let scanned = 0;
  let offset: string | undefined;
  const requestedOffsets = new Set<string>();
  const complete = (
    scanTruncated: boolean,
    nextOffset?: string,
  ): Result<
    Readonly<{ items: readonly Item[]; meta: ProjectListMeta }>,
    Error
  > =>
    ok({
      items,
      meta: {
        scanned,
        returned: items.length,
        scan_truncated: scanTruncated,
        ...(nextOffset === undefined ? {} : { next_offset: nextOffset }),
      },
    });

  for (;;) {
    if (offset !== undefined) requestedOffsets.add(offset);
    const remaining = prepared.scanCap - scanned;
    const page = await readPage(Math.min(100, remaining), offset);
    if (!page.ok) return page;
    if (
      page.value.nextOffset !== undefined &&
      (page.value.items.length === 0 ||
        requestedOffsets.has(page.value.nextOffset))
    ) {
      return err(paginationError);
    }

    const withinBudget = page.value.items.slice(0, remaining);
    for (const [index, item] of withinBudget.entries()) {
      scanned += 1;
      items.push(item);
      if (
        prepared.resultCap !== undefined &&
        items.length >= prepared.resultCap
      ) {
        const stoppedMidPage = index < page.value.items.length - 1;
        return complete(
          scanned >= prepared.scanCap &&
            (stoppedMidPage || page.value.nextOffset !== undefined),
          stoppedMidPage ? undefined : page.value.nextOffset,
        );
      }
    }

    if (scanned >= prepared.scanCap) {
      const pageExceedsBudget = page.value.items.length > withinBudget.length;
      return complete(
        pageExceedsBudget || page.value.nextOffset !== undefined,
        pageExceedsBudget ? undefined : page.value.nextOffset,
      );
    }
    if (page.value.nextOffset === undefined) return complete(false);
    offset = page.value.nextOffset;
  }
};

export const executeProjectList = async (
  token: string,
  prepared: PreparedProjectList,
  dependencies: Readonly<{ reader: ProjectGateway }>,
): Promise<
  Result<
    Readonly<{ projects: readonly ProjectListItem[]; meta: ProjectListMeta }>,
    ProjectListError
  >
> => {
  const result = await executeBoundedPages<ProjectListItem, ProjectListError>(
    prepared,
    async (limit, offset) => {
      const page = await dependencies.reader.listProjects(
        token,
        prepared.workspaceGid,
        { limit, ...(offset === undefined ? {} : { offset }) },
      );
      return page.ok
        ? ok({
            items: page.value.projects,
            ...(page.value.nextOffset === undefined
              ? {}
              : { nextOffset: page.value.nextOffset }),
          })
        : page;
    },
    {
      kind: "invalid_response",
      message: "Project pagination did not advance",
    },
  );
  return result.ok
    ? ok({ projects: result.value.items, meta: result.value.meta })
    : result;
};

export type ProjectSectionListMeta = ProjectListMeta;

export const executeProjectSectionList = async (
  token: string,
  prepared: PreparedProjectSectionList,
  dependencies: Readonly<{ reader: ProjectSectionGateway }>,
): Promise<
  Result<
    Readonly<{
      sections: readonly ProjectSection[];
      meta: ProjectSectionListMeta;
    }>,
    ProjectReadError
  >
> => {
  const result = await executeBoundedPages<ProjectSection, ProjectReadError>(
    prepared,
    async (limit, offset) => {
      const page = await dependencies.reader.listProjectSections({
        token,
        projectGid: prepared.projectGid,
        limit,
        ...(offset === undefined ? {} : { offset }),
        fields: prepared.fields,
      });
      return page.ok
        ? ok({
            items: page.value.sections,
            ...(page.value.nextOffset === undefined
              ? {}
              : { nextOffset: page.value.nextOffset }),
          })
        : page;
    },
    {
      kind: "invalid_response",
      message: "Project section pagination did not advance",
    },
  );
  return result.ok
    ? ok({ sections: result.value.items, meta: result.value.meta })
    : result;
};

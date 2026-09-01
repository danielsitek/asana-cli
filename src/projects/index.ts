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

type ProjectListOutput = Readonly<{
  projects: readonly ProjectListItem[];
  meta: ProjectListMeta;
}>;

type ProjectPageProgress =
  | Readonly<{
      kind: "complete";
      result: Result<ProjectListOutput, ProjectListError>;
    }>
  | Readonly<{ kind: "continue"; scanned: number; offset: string }>;

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
  if (options.all && options.max === undefined) {
    return err({ kind: "invalid_usage", message: "--all requires --max" });
  }
  const scanCap =
    options.max === undefined ? ok(DEFAULT_SCAN_CAP) : parseMax(options.max);
  if (!scanCap.ok) return scanCap;
  return ok({
    projectGid: projectGid.value,
    scanCap: scanCap.value,
    ...(options.all ? {} : { resultCap: DEFAULT_RESULT_CAP }),
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
  if (options.all && options.max === undefined) {
    return err({ kind: "invalid_usage", message: "--all requires --max" });
  }
  const scanCap =
    options.max === undefined ? ok(DEFAULT_SCAN_CAP) : parseMax(options.max);
  if (!scanCap.ok) return scanCap;
  return ok({
    workspaceGid,
    scanCap: scanCap.value,
    ...(options.all ? {} : { resultCap: DEFAULT_RESULT_CAP }),
  });
};

const completeProjectList = (
  projects: readonly ProjectListItem[],
  scanned: number,
  scanTruncated: boolean,
  nextOffset?: string,
): Result<ProjectListOutput, ProjectListError> =>
  ok({
    projects,
    meta: {
      scanned,
      returned: projects.length,
      scan_truncated: scanTruncated,
      ...(nextOffset === undefined ? {} : { next_offset: nextOffset }),
    },
  });

const paginationAdvanced = (
  page: ProjectListPage,
  requestedOffsets: ReadonlySet<string>,
): boolean =>
  page.nextOffset === undefined ||
  (page.projects.length > 0 && !requestedOffsets.has(page.nextOffset));

const completeAtResultCap = (
  page: ProjectListPage,
  projects: readonly ProjectListItem[],
  scanned: number,
  index: number,
  scanCap: number,
): ProjectPageProgress => {
  const stoppedMidPage = index < page.projects.length - 1;
  const truncated =
    scanned >= scanCap && (stoppedMidPage || page.nextOffset !== undefined);
  return {
    kind: "complete",
    result: completeProjectList(
      projects,
      scanned,
      truncated,
      stoppedMidPage ? undefined : page.nextOffset,
    ),
  };
};

const processProjectPage = (
  page: ProjectListPage,
  prepared: PreparedProjectList,
  projects: ProjectListItem[],
  previouslyScanned: number,
): ProjectPageProgress => {
  const remaining = prepared.scanCap - previouslyScanned;
  const withinBudget = page.projects.slice(0, remaining);
  let scanned = previouslyScanned;

  for (const [index, project] of withinBudget.entries()) {
    scanned += 1;
    projects.push(project);
    if (
      prepared.resultCap !== undefined &&
      projects.length >= prepared.resultCap
    ) {
      return completeAtResultCap(
        page,
        projects,
        scanned,
        index,
        prepared.scanCap,
      );
    }
  }

  if (scanned >= prepared.scanCap) {
    const pageExceedsBudget = page.projects.length > withinBudget.length;
    return {
      kind: "complete",
      result: completeProjectList(
        projects,
        scanned,
        pageExceedsBudget || page.nextOffset !== undefined,
        pageExceedsBudget ? undefined : page.nextOffset,
      ),
    };
  }
  return page.nextOffset === undefined
    ? {
        kind: "complete",
        result: completeProjectList(projects, scanned, false),
      }
    : { kind: "continue", scanned, offset: page.nextOffset };
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
  const projects: ProjectListItem[] = [];
  let scanned = 0;
  let offset: string | undefined;
  const requestedOffsets = new Set<string>();

  for (;;) {
    if (offset !== undefined) requestedOffsets.add(offset);
    const page = await dependencies.reader.listProjects(
      token,
      prepared.workspaceGid,
      {
        limit: Math.min(100, prepared.scanCap - scanned),
        ...(offset === undefined ? {} : { offset }),
      },
    );
    if (!page.ok) return page;
    if (!paginationAdvanced(page.value, requestedOffsets)) {
      return err({
        kind: "invalid_response",
        message: "Project pagination did not advance",
      });
    }
    const progress = processProjectPage(
      page.value,
      prepared,
      projects,
      scanned,
    );
    if (progress.kind === "complete") return progress.result;
    scanned = progress.scanned;
    offset = progress.offset;
  }
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
  const sections: ProjectSection[] = [];
  let scanned = 0;
  let offset: string | undefined;
  const requestedOffsets = new Set<string>();

  const complete = (
    scanTruncated: boolean,
    nextOffset?: string,
  ): Result<
    Readonly<{
      sections: readonly ProjectSection[];
      meta: ProjectSectionListMeta;
    }>,
    ProjectReadError
  > =>
    ok({
      sections,
      meta: {
        scanned,
        returned: sections.length,
        scan_truncated: scanTruncated,
        ...(nextOffset === undefined ? {} : { next_offset: nextOffset }),
      },
    });

  for (;;) {
    if (offset !== undefined) requestedOffsets.add(offset);
    const remaining = prepared.scanCap - scanned;
    const page = await dependencies.reader.listProjectSections({
      token,
      projectGid: prepared.projectGid,
      limit: Math.min(100, remaining),
      ...(offset === undefined ? {} : { offset }),
      fields: prepared.fields,
    });
    if (!page.ok) return page;
    if (
      page.value.nextOffset !== undefined &&
      (page.value.sections.length === 0 ||
        requestedOffsets.has(page.value.nextOffset))
    ) {
      return err({
        kind: "invalid_response",
        message: "Project section pagination did not advance",
      });
    }

    const withinBudget = page.value.sections.slice(0, remaining);
    for (const [index, section] of withinBudget.entries()) {
      scanned += 1;
      sections.push(section);
      if (
        prepared.resultCap !== undefined &&
        sections.length >= prepared.resultCap
      ) {
        const stoppedMidPage = index < page.value.sections.length - 1;
        return complete(
          scanned >= prepared.scanCap &&
            (stoppedMidPage || page.value.nextOffset !== undefined),
          stoppedMidPage ? undefined : page.value.nextOffset,
        );
      }
    }

    if (scanned >= prepared.scanCap) {
      const pageExceedsBudget =
        page.value.sections.length > withinBudget.length;
      return complete(
        pageExceedsBudget || page.value.nextOffset !== undefined,
        pageExceedsBudget ? undefined : page.value.nextOffset,
      );
    }
    if (page.value.nextOffset === undefined) return complete(false);
    offset = page.value.nextOffset;
  }
};

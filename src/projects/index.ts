import type { IdentityError } from "../identity/index.ts";
import { err, ok, type Result } from "../shared/result.ts";

export type Project = Readonly<{ gid: string; name: string }>;

export type ProjectListError = IdentityError;

export type ProjectListPage = Readonly<{
  projects: readonly Project[];
  nextOffset?: string;
}>;

export interface ProjectGateway {
  listProjects(
    _token: string,
    _workspaceGid: string,
    _options: Readonly<{ limit: number; offset?: string }>,
  ): Promise<Result<ProjectListPage, ProjectListError>>;
}

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
  projects: readonly Project[];
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
  projects: readonly Project[],
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
  projects: readonly Project[],
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
  projects: Project[],
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
    Readonly<{ projects: readonly Project[]; meta: ProjectListMeta }>,
    ProjectListError
  >
> => {
  const projects: Project[] = [];
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

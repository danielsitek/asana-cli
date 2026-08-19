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
    token: string,
    workspaceGid: string,
    options: Readonly<{ limit: number; offset?: string }>,
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

  while (scanned < prepared.scanCap) {
    if (offset !== undefined) requestedOffsets.add(offset);
    const remaining = prepared.scanCap - scanned;
    const page = await dependencies.reader.listProjects(
      token,
      prepared.workspaceGid,
      {
        limit: Math.min(100, remaining),
        ...(offset === undefined ? {} : { offset }),
      },
    );
    if (!page.ok) return page;

    const { projects: pageProjects, nextOffset } = page.value;
    if (
      nextOffset !== undefined &&
      (pageProjects.length === 0 || requestedOffsets.has(nextOffset))
    ) {
      return err({
        kind: "invalid_response",
        message: "Project pagination did not advance",
      });
    }

    const projectsWithinBudget = pageProjects.slice(0, remaining);
    const pageExceedsBudget = pageProjects.length > projectsWithinBudget.length;
    for (const [index, project] of projectsWithinBudget.entries()) {
      scanned += 1;
      projects.push(project);
      if (
        prepared.resultCap !== undefined &&
        projects.length >= prepared.resultCap
      ) {
        const stoppedMidPage = index < pageProjects.length - 1;
        const scanCapReached = scanned >= prepared.scanCap;
        return ok({
          projects,
          meta: {
            scanned,
            returned: projects.length,
            scan_truncated:
              scanCapReached && (stoppedMidPage || nextOffset !== undefined),
            ...(!stoppedMidPage && nextOffset !== undefined
              ? { next_offset: nextOffset }
              : {}),
          },
        });
      }
    }

    if (scanned >= prepared.scanCap) {
      return ok({
        projects,
        meta: {
          scanned,
          returned: projects.length,
          scan_truncated: pageExceedsBudget || nextOffset !== undefined,
          ...(pageExceedsBudget || nextOffset === undefined
            ? {}
            : { next_offset: nextOffset }),
        },
      });
    }
    if (nextOffset === undefined) {
      return ok({
        projects,
        meta: { scanned, returned: projects.length, scan_truncated: false },
      });
    }
    offset = nextOffset;
  }

  return ok({
    projects,
    meta: { scanned, returned: projects.length, scan_truncated: false },
  });
};

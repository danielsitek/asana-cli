import type { IdentityError } from "../identity/index.ts";
import type { Result } from "../shared/result.ts";

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

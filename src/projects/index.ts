import {
  collectPages,
  prepareListBounds,
  type ListBounds,
  type ListMeta,
  type ListOptions,
} from "../pagination/index.ts";
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

export type ProjectCustomFieldSetting = Readonly<{
  gid?: string;
  is_important?: boolean;
  custom_field?: Record<string, unknown>;
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

export type ProjectCustomFieldSettingPage = Readonly<{
  settings: readonly ProjectCustomFieldSetting[];
  nextOffset?: string;
}>;

export interface ProjectCustomFieldSettingGateway {
  listProjectCustomFieldSettings(
    request: Readonly<{
      token: string;
      projectGid: string;
      limit: number;
      offset?: string;
      fields: readonly string[];
    }>,
  ): Promise<Result<ProjectCustomFieldSettingPage, ProjectReadError>>;
}

export const DEFAULT_PROJECT_FIELDS = ["gid", "name", "archived"] as const;
export const DEFAULT_PROJECT_SECTION_FIELDS = ["gid", "name"] as const;
export const DEFAULT_PROJECT_CUSTOM_FIELD_SETTING_FIELDS = [
  "gid",
  "is_important",
  "custom_field.gid",
  "custom_field.name",
  "custom_field.resource_subtype",
] as const;

export const parseProjectGid = (
  input: string,
): Result<string, Readonly<{ kind: "invalid_usage"; message: string }>> =>
  /^\d+$/.test(input)
    ? ok(input)
    : err({
        kind: "invalid_usage",
        message: "Invalid project identifier",
      });

export type ProjectListOptions = ListOptions & Readonly<{ workspace?: string }>;
export type PreparedProjectList = ListBounds &
  Readonly<{ workspaceGid: string }>;
export type ProjectListMeta = ListMeta;

export type ProjectSectionListOptions = ListOptions &
  Readonly<{
    projectGid: string;
    fields: readonly string[];
  }>;

export type PreparedProjectSectionList = ListBounds &
  Readonly<{
    projectGid: string;
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
  const bounded = prepareListBounds(options);
  if (!bounded.ok) return bounded;
  return ok({
    projectGid: projectGid.value,
    ...bounded.value,
    fields: options.fields,
  });
};

export type ProjectCustomFieldSettingListOptions = ProjectSectionListOptions;
export type PreparedProjectCustomFieldSettingList = PreparedProjectSectionList;

export const prepareProjectCustomFieldSettingList = (
  options: ProjectCustomFieldSettingListOptions,
): Result<
  PreparedProjectCustomFieldSettingList,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  const projectGid = parseProjectGid(options.projectGid);
  if (!projectGid.ok) return projectGid;
  const bounded = prepareListBounds(options);
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
  const bounded = prepareListBounds(options);
  return bounded.ok ? ok({ workspaceGid, ...bounded.value }) : bounded;
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
  const result = await collectPages<
    ProjectListItem,
    ProjectListItem,
    ProjectListError
  >(
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
            nextOffset: page.value.nextOffset,
          })
        : page;
    },
    (item) => item,
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
  const result = await collectPages<
    ProjectSection,
    ProjectSection,
    ProjectReadError
  >(
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
            nextOffset: page.value.nextOffset,
          })
        : page;
    },
    (item) => item,
    {
      kind: "invalid_response",
      message: "Project section pagination did not advance",
    },
  );
  return result.ok
    ? ok({ sections: result.value.items, meta: result.value.meta })
    : result;
};

export const executeProjectCustomFieldSettingList = async (
  token: string,
  prepared: PreparedProjectCustomFieldSettingList,
  dependencies: Readonly<{ reader: ProjectCustomFieldSettingGateway }>,
): Promise<
  Result<
    Readonly<{
      settings: readonly ProjectCustomFieldSetting[];
      meta: ProjectListMeta;
    }>,
    ProjectReadError
  >
> => {
  const result = await collectPages<
    ProjectCustomFieldSetting,
    ProjectCustomFieldSetting,
    ProjectReadError
  >(
    prepared,
    async (limit, offset) => {
      const page = await dependencies.reader.listProjectCustomFieldSettings({
        token,
        projectGid: prepared.projectGid,
        limit,
        ...(offset === undefined ? {} : { offset }),
        fields: prepared.fields,
      });
      return page.ok
        ? ok({
            items: page.value.settings,
            nextOffset: page.value.nextOffset,
          })
        : page;
    },
    (item) => item,
    {
      kind: "invalid_response",
      message: "Project custom field setting pagination did not advance",
    },
  );
  return result.ok
    ? ok({ settings: result.value.items, meta: result.value.meta })
    : result;
};

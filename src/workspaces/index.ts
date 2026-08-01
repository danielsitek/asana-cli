import type { IdentityError } from "../identity/index.ts";
import { err, ok, type Result } from "../shared/result.ts";

export type Workspace = Readonly<{ gid: string; name: string }>;

export type WorkspaceListError = IdentityError;

export interface WorkspaceGateway {
  listWorkspaces(
    token: string,
    options: Readonly<{ limit: number; offset?: string }>,
  ): Promise<
    Result<
      Readonly<{ workspaces: readonly Workspace[]; nextOffset?: string }>,
      WorkspaceListError
    >
  >;
}

export const executeWorkspacesList = async (
  token: string,
  dependencies: Readonly<{ reader: WorkspaceGateway }>,
): Promise<Result<readonly Workspace[], WorkspaceListError>> => {
  const workspaces: Workspace[] = [];
  let offset: string | undefined;
  const requestedOffsets = new Set<string>();

  for (;;) {
    if (offset !== undefined) requestedOffsets.add(offset);
    const page = await dependencies.reader.listWorkspaces(token, {
      limit: 100,
      ...(offset === undefined ? {} : { offset }),
    });
    if (!page.ok) return page;

    const { workspaces: pageWorkspaces, nextOffset } = page.value;
    if (
      nextOffset !== undefined &&
      (pageWorkspaces.length === 0 || requestedOffsets.has(nextOffset))
    ) {
      return err({
        kind: "invalid_response",
        message: "Workspace pagination did not advance",
      });
    }
    workspaces.push(...pageWorkspaces);
    if (nextOffset === undefined) break;
    offset = nextOffset;
  }

  return ok(workspaces);
};

import type {
  MyTaskSectionsDiscoveryGateway,
  MyTasksDiscoveryGateway,
  ConfigContext,
} from "../config/index.ts";
import type {
  TaskCommentCreationGateway,
  TaskStoryGateway,
} from "../comments/index.ts";
import type { IdentityGateway } from "../identity/index.ts";
import type {
  ProjectCustomFieldSettingGateway,
  ProjectGateway,
  ProjectReadGateway,
  ProjectSectionGateway,
} from "../projects/index.ts";
import type {
  TaskCreationGateway,
  TaskGateway,
  TaskListGateway,
  TaskMutationGateway,
  TaskParentMutationGateway,
  TaskProjectMutationGateway,
  TaskSectionMutationGateway,
} from "../tasks/index.ts";
import type { UpdateNotice } from "../update/index.ts";
import type { WorkspaceGateway } from "../workspaces/index.ts";

export type Execution = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export type ExecuteDependencies = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  stdoutIsTTY?: boolean;
  identity: IdentityGateway;
  taskReader?: TaskGateway;
  taskCreator?: TaskCreationGateway;
  taskWriter?: TaskMutationGateway;
  taskParentWriter?: TaskParentMutationGateway;
  taskProjectWriter?: TaskProjectMutationGateway;
  taskSectionWriter?: TaskSectionMutationGateway;
  taskListReader?: TaskListGateway;
  commentReader?: TaskStoryGateway;
  commentWriter?: TaskCommentCreationGateway;
  workspaceReader?: WorkspaceGateway;
  projectReader?: ProjectGateway;
  projectDetailReader?: ProjectReadGateway;
  projectSectionReader?: ProjectSectionGateway;
  projectCustomFieldSettingReader?: ProjectCustomFieldSettingGateway;
  readFile?: (path: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  discovery?: MyTasksDiscoveryGateway;
  myTaskSectionsDiscovery?: MyTaskSectionsDiscoveryGateway;
  configuration?: ConfigContext;
  version?: string;
  checkForUpdate?: () => Promise<UpdateNotice | undefined>;
}>;

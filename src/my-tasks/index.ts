import {
  resolveConfig,
  type ConfigContext,
  type ConfigError,
  type DiscoveredMyTasks,
  type MyTasksDiscoveryGateway,
} from "../config/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type {
  MyTasksMutationError,
  MyTasksMutationRequest,
  MyTasksMutationResolver,
  MyTasksMutationResult,
  ResourceSelector,
  TaskGateway,
  TaskReadError,
} from "../tasks/index.ts";

export type MyTasksMutationDependencies = Readonly<{
  configuration: ConfigContext;
  discovery: MyTasksDiscoveryGateway;
  reader: TaskGateway;
  resolveAuthenticatedUserGid: (
    token: string,
  ) => Promise<Result<string, TaskReadError>>;
}>;

const configurationError = (message: string): ConfigError => ({
  kind: "configuration",
  message,
});

const resolveAlias = (
  selector: ResourceSelector,
  aliases: Readonly<Record<string, string>> | undefined,
  resource: string,
): Result<string, ConfigError> => {
  if (selector.kind === "gid") return ok(selector.value);
  const gid = aliases?.[selector.value];
  return gid
    ? ok(gid)
    : err(
        configurationError(
          `${resource} alias @${selector.value} is not configured`,
        ),
      );
};

const validateDiscoveredResources = (
  discovered: DiscoveredMyTasks,
  configuredUserTaskListGid: string,
  sectionGid: string | undefined,
  customFieldGids: readonly string[],
): Result<void, ConfigError> => {
  if (discovered.userTaskListGid !== configuredUserTaskListGid) {
    return err(
      configurationError(
        "Configured My Tasks list does not match the authenticated user's list",
      ),
    );
  }
  if (
    sectionGid !== undefined &&
    !discovered.sections.some((section) => section.gid === sectionGid)
  ) {
    return err(
      configurationError(
        `My Tasks section ${sectionGid} is not present in the configured list`,
      ),
    );
  }
  for (const gid of customFieldGids) {
    const field = discovered.customFields.find(
      (candidate) => candidate.gid === gid,
    );
    if (!field) {
      return err(
        configurationError(
          `Custom field ${gid} is not present in the configured My Tasks list`,
        ),
      );
    }
    if (field.resourceSubtype !== "number") {
      return err(
        configurationError(`Custom field ${gid} is not a number field`),
      );
    }
    if (field.isReadOnly) {
      return err(configurationError(`Custom field ${gid} is read-only`));
    }
  }
  return ok(undefined);
};

const resolveMutation = async (
  request: MyTasksMutationRequest,
  dependencies: MyTasksMutationDependencies,
): Promise<Result<MyTasksMutationResult, MyTasksMutationError>> => {
  const resolved = await resolveConfig(dependencies.configuration);
  if (!resolved.ok) return resolved;
  const workspaceGid = resolved.value.value.workspace?.gid;
  const configuredMyTasks = resolved.value.value.myTasks;
  if (!workspaceGid) {
    return err(
      configurationError("workspace.gid is required in configuration"),
    );
  }
  if (!configuredMyTasks?.userTaskListGid) {
    return err(
      configurationError(
        "myTasks.userTaskListGid is required in local configuration",
      ),
    );
  }

  const sectionGid = request.mySection
    ? resolveAlias(
        request.mySection,
        configuredMyTasks.sections,
        "My Tasks section",
      )
    : ok(undefined);
  if (!sectionGid.ok) return sectionGid;

  const customFields: Record<string, number | null> = {};
  for (const customField of request.customFields) {
    const gid = resolveAlias(
      customField.field,
      configuredMyTasks.customFields,
      "Custom field",
    );
    if (!gid.ok) return gid;
    if (Object.hasOwn(customFields, gid.value)) {
      return err({
        kind: "invalid_usage",
        message: "--custom-field cannot update the same field more than once",
      });
    }
    customFields[gid.value] = customField.value;
  }

  const discovered = await dependencies.discovery.discoverMyTasks(
    request.token,
    workspaceGid,
  );
  if (!discovered.ok) return discovered;
  const validated = validateDiscoveredResources(
    discovered.value,
    configuredMyTasks.userTaskListGid,
    sectionGid.value,
    Object.keys(customFields),
  );
  if (!validated.ok) return validated;

  const identity = request.authenticatedUserGid
    ? ok(request.authenticatedUserGid)
    : await dependencies.resolveAuthenticatedUserGid(request.token);
  if (!identity.ok) return identity;
  let finalAssignee = request.finalAssignee;
  if (finalAssignee === undefined) {
    const current = await dependencies.reader.getTask(
      request.token,
      request.taskId,
      ["assignee.gid"],
    );
    if (!current.ok) return current;
    finalAssignee = current.value.assignee?.gid;
  }
  if (finalAssignee !== identity.value) {
    return err({
      kind: "invalid_usage",
      message:
        "My Tasks mutations require the final assignee to be the authenticated user",
    });
  }

  const sortedCustomFields = Object.fromEntries(
    Object.entries(customFields).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  return ok({
    ...(sectionGid.value === undefined
      ? {}
      : { assignee_section: sectionGid.value }),
    ...(Object.keys(sortedCustomFields).length === 0
      ? {}
      : { custom_fields: sortedCustomFields }),
  });
};

export const createMyTasksMutationResolver = (
  dependencies: MyTasksMutationDependencies,
): MyTasksMutationResolver => ({
  resolve: (request) => resolveMutation(request, dependencies),
});

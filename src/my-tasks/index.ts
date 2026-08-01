import {
  resolveConfig,
  type ConfigContext,
  type ConfigError,
  type DiscoveredCustomField,
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
  reader?: TaskGateway;
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
  return ok(undefined);
};

const sortedUniqueNames = (names: readonly string[]): readonly string[] =>
  [...new Set(names)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

const parseNumberValue = (input: string): Result<number, string> => {
  if (!/^-?\d+(?:\.\d+)?$/.test(input)) {
    return err("Custom field value must be an integer, dot-decimal, or null");
  }
  const value = Number(input);
  return Number.isFinite(value)
    ? ok(value)
    : err("Custom field value must be finite");
};

const resolveEnumValue = (
  raw: string,
  field: Extract<DiscoveredCustomField, Readonly<{ resourceSubtype: "enum" }>>,
): Result<string, ConfigError> => {
  const options = field.enumOptions;
  const enabled = options.filter((option) => option.enabled);
  const validNames = sortedUniqueNames(
    enabled.map((option) => option.name),
  ).join(", ");
  if (/^\d+$/.test(raw)) {
    const byGid = options.find((option) => option.gid === raw);
    if (byGid) {
      return byGid.enabled
        ? ok(byGid.gid)
        : err(
            configurationError(
              `Custom field ${field.gid} option GID ${raw} is disabled; valid options: ${validNames}`,
            ),
          );
    }
  }
  const matches = enabled.filter((option) => option.name === raw);
  if (matches.length > 1) {
    return err(
      configurationError(
        `Custom field ${field.gid} option "${raw}" is ambiguous; valid options: ${validNames}`,
      ),
    );
  }
  if (matches.length === 1 && matches[0]) {
    return ok(matches[0].gid);
  }
  return err(
    configurationError(
      `Custom field ${field.gid} option "${raw}" is unknown; valid options: ${validNames}`,
    ),
  );
};

const resolveCustomFieldValues = (
  discoveredFields: readonly DiscoveredCustomField[],
  rawCustomFields: Readonly<Record<string, string | null>>,
): Result<Record<string, number | string | null>, MyTasksMutationError> => {
  const resolved: Record<string, number | string | null> = {};
  for (const [gid, raw] of Object.entries(rawCustomFields)) {
    const field = discoveredFields.find((candidate) => candidate.gid === gid);
    if (!field) {
      return err(
        configurationError(
          `Custom field ${gid} is not present in the configured My Tasks list`,
        ),
      );
    }
    if (field.resourceSubtype === "unsupported") {
      return err(
        configurationError(
          `Custom field ${gid} is not a number or enum field (${field.originalResourceSubtype})`,
        ),
      );
    }
    if (field.isReadOnly) {
      return err(configurationError(`Custom field ${gid} is read-only`));
    }
    if (raw === null) {
      resolved[gid] = null;
      continue;
    }
    if (field.resourceSubtype === "number") {
      const value = parseNumberValue(raw);
      if (!value.ok) {
        return err({ kind: "invalid_usage", message: value.error });
      }
      resolved[gid] = value.value;
      continue;
    }
    const value = resolveEnumValue(raw, field);
    if (!value.ok) return value;
    resolved[gid] = value.value;
  }
  return ok(resolved);
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

  const rawCustomFields: Record<string, string | null> = {};
  for (const customField of request.customFields) {
    const gid = resolveAlias(
      customField.field,
      configuredMyTasks.customFields,
      "Custom field",
    );
    if (!gid.ok) return gid;
    if (Object.hasOwn(rawCustomFields, gid.value)) {
      return err({
        kind: "invalid_usage",
        message: "--custom-field cannot update the same field more than once",
      });
    }
    rawCustomFields[gid.value] = customField.value;
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
  );
  if (!validated.ok) return validated;

  const resolvedCustomFields = resolveCustomFieldValues(
    discovered.value.customFields,
    rawCustomFields,
  );
  if (!resolvedCustomFields.ok) return resolvedCustomFields;
  const customFields = resolvedCustomFields.value;

  const identity = request.authenticatedUserGid
    ? ok(request.authenticatedUserGid)
    : await dependencies.resolveAuthenticatedUserGid(request.token);
  if (!identity.ok) return identity;
  let finalAssignee = request.finalAssignee;
  if (finalAssignee === undefined) {
    if (request.taskId === undefined || dependencies.reader === undefined) {
      return err({
        kind: request.taskId === undefined ? "invalid_usage" : "internal_error",
        message:
          request.taskId === undefined
            ? "My Tasks mutations require an explicitly resolvable final assignee"
            : "Task reader is required to resolve the final assignee",
      });
    }
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

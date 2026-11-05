import type { DiscoveredCustomField } from "../config/index.ts";
import { resolveCustomFieldValues } from "../my-tasks/index.ts";
import type {
  ProjectCustomFieldSetting,
  ProjectCustomFieldSettingGateway,
} from "../projects/index.ts";
import { err, ok, type Result } from "../shared/result.ts";
import type {
  PreparedCustomField,
  ProjectCustomFieldResolver,
  TaskGateway,
  TaskUpdateError,
} from "./index.ts";

const SETTING_FIELDS = [
  "custom_field.gid",
  "custom_field.name",
  "custom_field.resource_subtype",
  "custom_field.is_value_read_only",
  "custom_field.enum_options.gid",
  "custom_field.enum_options.name",
  "custom_field.enum_options.enabled",
] as const;

const invalidResponse = (message: string): TaskUpdateError => ({
  kind: "invalid_response",
  message,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const taskProjects = (
  value: unknown,
): Result<readonly string[], TaskUpdateError> => {
  if (
    !Array.isArray(value) ||
    !value.every(
      (project) =>
        isRecord(project) &&
        typeof project.gid === "string" &&
        /^\d+$/.test(project.gid),
    )
  ) {
    return err(invalidResponse("Asana returned a task without valid projects"));
  }
  return ok([...new Set(value.map((project) => project.gid as string))]);
};

const discoveredField = (
  setting: ProjectCustomFieldSetting,
): Result<DiscoveredCustomField, TaskUpdateError> => {
  const field = setting.custom_field;
  if (
    !isRecord(field) ||
    typeof field.gid !== "string" ||
    !/^\d+$/.test(field.gid) ||
    typeof field.name !== "string" ||
    typeof field.resource_subtype !== "string" ||
    typeof field.is_value_read_only !== "boolean"
  ) {
    return err(
      invalidResponse("Asana returned an invalid project custom field"),
    );
  }
  const base = {
    gid: field.gid,
    name: field.name,
    isReadOnly: field.is_value_read_only,
  };
  if (field.resource_subtype === "number") {
    return ok({ ...base, resourceSubtype: "number" });
  }
  if (field.resource_subtype !== "enum") {
    return ok({
      ...base,
      resourceSubtype: "unsupported",
      originalResourceSubtype: field.resource_subtype,
    });
  }
  const options = field.enum_options;
  if (
    !Array.isArray(options) ||
    !options.every(
      (option) =>
        isRecord(option) &&
        typeof option.gid === "string" &&
        /^\d+$/.test(option.gid) &&
        typeof option.name === "string" &&
        typeof option.enabled === "boolean",
    )
  ) {
    return err(
      invalidResponse(
        `Asana returned enum custom field ${field.gid} without valid options`,
      ),
    );
  }
  return ok({
    ...base,
    resourceSubtype: "enum",
    enumOptions: options.map((option) => ({
      gid: option.gid as string,
      name: option.name as string,
      enabled: option.enabled as boolean,
    })),
  });
};

const readProjectFields = async (
  token: string,
  projectGid: string,
  gateway: ProjectCustomFieldSettingGateway,
): Promise<Result<readonly DiscoveredCustomField[], TaskUpdateError>> => {
  const fields: DiscoveredCustomField[] = [];
  const offsets = new Set<string>();
  let offset: string | undefined;
  do {
    const page = await gateway.listProjectCustomFieldSettings({
      token,
      projectGid,
      limit: 100,
      ...(offset === undefined ? {} : { offset }),
      fields: SETTING_FIELDS,
    });
    if (!page.ok) return page;
    for (const setting of page.value.settings) {
      const field = discoveredField(setting);
      if (!field.ok) return field;
      fields.push(field.value);
    }
    offset = page.value.nextOffset;
    if (offset !== undefined) {
      if (page.value.settings.length === 0 || offsets.has(offset)) {
        return err(
          invalidResponse("Project custom field pagination did not advance"),
        );
      }
      offsets.add(offset);
    }
  } while (offset !== undefined);
  return ok(fields);
};

const resolve = async (
  token: string,
  taskId: string,
  fields: readonly PreparedCustomField[],
  taskReader: TaskGateway,
  settingsReader: ProjectCustomFieldSettingGateway,
): Promise<
  Result<
    Readonly<{
      resolved: Readonly<Record<string, number | string | null>>;
      remaining: readonly PreparedCustomField[];
    }>,
    TaskUpdateError
  >
> => {
  const task = await taskReader.getTask(token, taskId, ["projects.gid"]);
  if (!task.ok) return task;
  const projects = taskProjects(task.value.projects);
  if (!projects.ok) return projects;
  const discovered: DiscoveredCustomField[] = [];
  for (const projectGid of projects.value) {
    const projectFields = await readProjectFields(
      token,
      projectGid,
      settingsReader,
    );
    if (!projectFields.ok) return projectFields;
    discovered.push(...projectFields.value);
  }
  const available = new Map(discovered.map((field) => [field.gid, field]));
  const raw: Record<string, string | null> = {};
  const remaining: PreparedCustomField[] = [];
  for (const field of fields) {
    if (field.field.kind !== "gid" || !available.has(field.field.value)) {
      remaining.push(field);
      continue;
    }
    if (Object.hasOwn(raw, field.field.value)) {
      return err({
        kind: "invalid_usage",
        message: "--custom-field cannot update the same field more than once",
      });
    }
    raw[field.field.value] = field.value;
  }
  const resolved = resolveCustomFieldValues([...available.values()], raw);
  return resolved.ok ? ok({ resolved: resolved.value, remaining }) : resolved;
};

export const createProjectCustomFieldResolver = (
  taskReader: TaskGateway,
  settingsReader: ProjectCustomFieldSettingGateway,
): ProjectCustomFieldResolver => ({
  resolve: (token, taskId, fields) =>
    resolve(token, taskId, fields, taskReader, settingsReader),
});

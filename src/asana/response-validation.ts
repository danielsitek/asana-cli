export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(value, key);

export const isDigitOnlyGid = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value);

export const isNullableNamedResource = (
  value: unknown,
  requestedFields: ReadonlySet<string>,
): boolean => {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (hasOwn(value, "gid") && !isDigitOnlyGid(value.gid)) return false;
  if (hasOwn(value, "name") && typeof value.name !== "string") return false;
  for (const field of requestedFields) {
    if (!hasOwn(value, field)) return false;
  }
  return true;
};

export const knownTaskFieldsAreValid = (
  value: Record<string, unknown>,
  requestedAssigneeFields: ReadonlySet<string>,
): boolean =>
  (!hasOwn(value, "gid") || isDigitOnlyGid(value.gid)) &&
  (!hasOwn(value, "name") || typeof value.name === "string") &&
  (!hasOwn(value, "notes") || typeof value.notes === "string") &&
  (!hasOwn(value, "completed") || typeof value.completed === "boolean") &&
  (!hasOwn(value, "due_on") ||
    typeof value.due_on === "string" ||
    value.due_on === null) &&
  (!hasOwn(value, "assignee") ||
    isNullableNamedResource(value.assignee, requestedAssigneeFields));

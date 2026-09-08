export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(value, key);

export const isDigitOnlyGid = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value);

type FieldValidator = readonly [
  field: string,
  validate: (value: unknown) => boolean,
];

export const knownFieldsAreValid = (
  value: Record<string, unknown>,
  validators: readonly FieldValidator[],
): boolean =>
  validators.every(
    ([field, validate]) => !hasOwn(value, field) || validate(value[field]),
  );

const isString = (value: unknown): boolean => typeof value === "string";

const isBoolean = (value: unknown): boolean => typeof value === "boolean";

const isNullableDate = (value: unknown): boolean =>
  typeof value === "string" || value === null;

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
  knownFieldsAreValid(value, [
    ["gid", isDigitOnlyGid],
    ["name", isString],
    ["notes", isString],
    ["completed", isBoolean],
    ["due_on", isNullableDate],
    [
      "assignee",
      (assignee) => isNullableNamedResource(assignee, requestedAssigneeFields),
    ],
  ]);

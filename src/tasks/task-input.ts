import { describeInput } from "../shared/input-diagnostic.ts";
import { err, ok, type Result } from "../shared/result.ts";

const DIGIT_ONLY_TASK_GID = /^\d+$/;
const LEGACY_TASK_URL = /^https:\/\/app\.asana\.com\/0\/(\d+)\/(\d+)(?:\/f)?$/;
const CURRENT_TASK_URL =
  /^https:\/\/app\.asana\.com\/1\/\d+\/(?:project\/\d+\/)?task\/(\d+)(?:\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/;

const parseLegacyTaskUrl = (input: string): string | undefined =>
  LEGACY_TASK_URL.exec(input)?.[2];

const parseCurrentTaskUrl = (input: string): string | undefined =>
  CURRENT_TASK_URL.exec(input)?.[1];

export const parseTaskId = (input: string): Result<string, string> => {
  if (DIGIT_ONLY_TASK_GID.test(input)) {
    return ok(input);
  }
  const urlTaskId = parseLegacyTaskUrl(input) ?? parseCurrentTaskUrl(input);
  return urlTaskId === undefined
    ? err(
        `Invalid task identifier ${describeInput(input.split(/[?#]/, 1)[0] ?? input)}. Use a task GID or Asana task URL.`,
      )
    : ok(urlTaskId);
};

export const validateFieldList = (
  input: string,
): Result<readonly string[], string> => {
  if (input.trim() === "") {
    return err("Fields list cannot be empty");
  }
  const segments = input.split(",");
  const processed: string[] = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed === "") {
      return err("Fields list cannot contain empty segments");
    }
    processed.push(trimmed);
  }
  const unique = Array.from(new Set(processed));
  return ok(unique);
};

export const prepareSelectedFields = (
  fieldsInput: string | undefined,
): Result<
  readonly string[] | undefined,
  Readonly<{ kind: "invalid_usage"; message: string }>
> => {
  if (fieldsInput === undefined) return ok(undefined);
  const validated = validateFieldList(fieldsInput);
  return validated.ok
    ? ok(validated.value)
    : err({ kind: "invalid_usage", message: validated.error });
};

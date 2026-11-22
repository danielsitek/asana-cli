import { ASANA_ERROR_CODES, asanaFailure } from "./errors.ts";
import {
  DEFAULT_FIELDS,
  parseTaskId,
  validateFieldList,
} from "../tasks/index.ts";
import { renderJson, renderTaskDetail } from "../output/index.ts";
import type { Result } from "../shared/result.ts";
import type { CommandResult } from "./contracts.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import {
  internalError,
  type TaskCommandContext,
  type TaskInvocation,
} from "./task-command-context.ts";

const selectedFields = (
  fields: string | undefined,
  usageError: TaskCommandContext["usageError"],
): Result<readonly string[], CommandResult> => {
  if (fields === undefined) return { ok: true, value: DEFAULT_FIELDS };
  const validated = validateFieldList(fields);
  return validated.ok
    ? validated
    : { ok: false, error: usageError(validated.error) };
};

const runTaskGet = async (
  context: TaskCommandContext,
  idArg: string,
  invocation: TaskInvocation,
): Promise<CommandResult> => {
  const parsedId = parseTaskId(idArg);
  if (!parsedId.ok) return context.usageError(parsedId.error);
  const fields = selectedFields(invocation.fields, context.usageError);
  if (!fields.ok) return fields.error;
  const token = context.requireToken();
  if (!token.ok) return token.error;
  const reader = context.dependencies.taskReader;
  if (!reader) return internalError("Task reader is required");
  const task = await reader.getTask(token.value, parsedId.value, fields.value);
  if (!task.ok) return asanaFailure(task.error);
  return {
    stdout: invocation.json
      ? renderJson(task.value)
      : renderTaskDetail(task.value),
    stderr: "",
    exitCode: 0,
  };
};

export const registerTaskReadCommand = (context: TaskCommandContext): void => {
  const command = context.tasks
    .command("get")
    .argument("<id>", "task GID or Asana task URL")
    .description("read a task's details")
    .action(async (idArg: string) => {
      context.complete(
        await runTaskGet(context, idArg, context.beginCommand()),
      );
    });
  withCommandCapabilities(command, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    errors: [...ASANA_ERROR_CODES, "not_found"],
  });
  command.exitOverride();
  command.configureOutput(context.outputConfiguration);
};

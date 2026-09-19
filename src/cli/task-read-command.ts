import {
  DEFAULT_FIELDS,
  parseTaskId,
  validateFieldList,
} from "../tasks/index.ts";
import { renderJson, renderTaskDetail } from "../output/index.ts";
import type { Result } from "../shared/result.ts";
import type { Execution } from "./contracts.ts";
import { withCommandCapabilities } from "./capabilities.ts";
import {
  internalError,
  renderTaskReadFailure,
  type TaskCommandContext,
  type TaskInvocation,
} from "./task-command-context.ts";

const selectedFields = (
  fields: string | undefined,
  usageError: TaskCommandContext["usageError"],
): Result<readonly string[], Execution> => {
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
): Promise<Execution> => {
  const parsedId = parseTaskId(idArg);
  if (!parsedId.ok) return context.usageError("Invalid task identifier");
  const fields = selectedFields(invocation.fields, context.usageError);
  if (!fields.ok) return fields.error;
  const token = context.requireToken();
  if (!token.ok) return token.error;
  const reader = context.dependencies.taskReader;
  if (!reader) return internalError("Task reader is required");
  const task = await reader.getTask(token.value, parsedId.value, fields.value);
  if (!task.ok) return renderTaskReadFailure(task.error.kind);
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
    .command("get <id>")
    .description("read a task's details")
    .action(async (idArg: string) => {
      context.complete(
        await runTaskGet(context, idArg, context.beginCommand()),
      );
    });
  withCommandCapabilities(command, {
    operation: "read",
    requirements: { authentication: "required", configuration: "never" },
    exitCodes: [0, 2, 3, 4, 5, 6],
  });
  command.exitOverride();
  command.configureOutput(context.outputConfiguration);
};

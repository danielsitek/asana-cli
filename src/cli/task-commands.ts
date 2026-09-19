import { registerTaskCommentCommand } from "./task-comment-command.ts";
import { registerTaskCommentsCommand } from "./task-comments-command.ts";
import type {
  TaskCommandContext,
  TaskCommandRegistration,
} from "./task-command-context.ts";
import { registerTaskCreateCommand } from "./task-create-command.ts";
import { registerTaskListCommand } from "./task-list-command.ts";
import { registerTaskReadCommand } from "./task-read-command.ts";
import { registerTaskUpdateCommand } from "./task-update-command.ts";
import { withCommandCapabilities } from "./capabilities.ts";

export const registerTaskCommands = ({
  program,
  ...registration
}: TaskCommandRegistration): void => {
  const tasks = program.command("tasks").description("manage tasks");
  withCommandCapabilities(tasks, {
    operation: "mixed",
    requirements: {
      authentication: "required",
      configuration: "conditional",
    },
    exitCodes: [0, 1, 2, 3, 4, 5, 6],
  });
  const context: TaskCommandContext = {
    ...registration,
    tasks,
  };
  registerTaskReadCommand(context);
  registerTaskUpdateCommand(context);
  registerTaskCreateCommand(context);
  registerTaskCommentsCommand(context);
  registerTaskCommentCommand(context);
  registerTaskListCommand(context);
};

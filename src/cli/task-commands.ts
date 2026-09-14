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

export const registerTaskCommands = ({
  program,
  ...registration
}: TaskCommandRegistration): void => {
  const context: TaskCommandContext = {
    ...registration,
    tasks: program.command("tasks").description("manage tasks"),
  };
  registerTaskReadCommand(context);
  registerTaskUpdateCommand(context);
  registerTaskCreateCommand(context);
  registerTaskCommentsCommand(context);
  registerTaskCommentCommand(context);
  registerTaskListCommand(context);
};

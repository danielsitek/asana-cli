const FIELD_SELECTING_COMMANDS = new Set([
  "tasks/get",
  "tasks/comments",
  "tasks/comment",
  "tasks/update",
  "tasks/create",
  "tasks/list",
  "projects/get",
  "projects/sections",
]);

export const acceptsFieldsOptionAtPath = (commandPath: string): boolean =>
  commandPath === "root" ||
  commandPath === "tasks" ||
  FIELD_SELECTING_COMMANDS.has(commandPath);

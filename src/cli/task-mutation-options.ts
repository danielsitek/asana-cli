import type { Command } from "commander";

export const withTaskMutationOptions = (command: Command): Command =>
  command
    .option("--name <text>", "set the task name")
    .option("--notes <text>", "replace task notes")
    .option("--notes-file <path>", "replace notes from a file or stdin with -")
    .option("--assignee <value>", "set me, a user GID, or null")
    .option("--due-on <date>", "set YYYY-MM-DD or null")
    .option("--completed <boolean>", "set true or false")
    .option("--my-section <section>", "move within My Tasks by GID or @alias")
    .option("--section <gid>", "place or move in any project section")
    .option(
      "--custom-field <field:value>",
      "set a number or enum My Tasks custom field by GID or @alias; enum value is an option GID or exact name; repeatable",
      (value: string, previous: readonly string[] | undefined) => [
        ...(previous ?? []),
        value,
      ],
    );

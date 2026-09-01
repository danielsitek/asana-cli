import { describe, expect, test } from "bun:test";
import { Command } from "commander";

import { isCompletionShell, renderCompletion } from "./index.ts";

const fixture = (): Command => {
  const program = new Command()
    .name("asana-cli")
    .option("--json", "output JSON")
    .option("--fields <fields>", "select explicit Asana fields");
  const tasks = program.command("tasks").description("manage tasks");
  tasks
    .command("get <id>")
    .description("read a task's details")
    .option("--file <path>", "read a file")
    .option("--completed <boolean>", "completion state");
  program
    .command("completion <shell>")
    .description("generate shell completion script");
  program.command("workspaces").command("list").description("list workspaces");
  program
    .command("projects")
    .command("sections <gid>")
    .description("list project sections")
    .option("--max <n>", "scan cap")
    .option("--all", "all within cap");
  return program;
};

describe("shell completion", () => {
  test("recognizes supported shells", () => {
    expect(isCompletionShell("bash")).toBe(true);
    expect(isCompletionShell("zsh")).toBe(true);
    expect(isCompletionShell("fish")).toBe(true);
    expect(isCompletionShell("powershell")).toBe(false);
  });

  test("renders nested Bash command and option transitions", () => {
    const output = renderCompletion(fixture(), "bash");
    expect(output).toContain("complete -F _asana_cli_completion asana-cli");
    expect(output).toContain("'root:tasks') context='tasks'");
    expect(output).toContain("'tasks:get') context='tasks/get'");
    expect(output).toContain(
      "'tasks') candidates='get help --json --fields -h --help'",
    );
    expect(output).toContain(
      "'tasks/get') candidates='--json --fields --file --completed -h --help'",
    );
    expect(output).toContain(
      "'workspaces/list') candidates='--json -h --help'",
    );
    expect(output).not.toContain(
      "'workspaces/list') candidates='--json --fields",
    );
    expect(output).toContain(
      "'tasks/get:--completed') candidates='true false'",
    );
    expect(output).toContain("'tasks/get:--completed='*)");
    expect(output).toContain('COMPREPLY=( "${COMPREPLY[@]/#/--completed=}" )');
    expect(output).toContain("'tasks/get:--file')");
    expect(output).toContain("'tasks/get:--file='*)");
    expect(output).toContain('COMPREPLY+=("${candidate}")');
    expect(output).toContain('COMPREPLY+=("--file=${candidate}")');
    expect(output).not.toContain("COMPREPLY=( $(compgen -f");
    expect(output).not.toContain("'workspaces/list:--fields'");
    expect(output).toContain(
      "'projects:sections') context='projects/sections'",
    );
    expect(output).toContain(
      "'projects/sections') candidates='--json --fields --max --all -h --help'",
    );
    expect(output).toContain(
      "'completion') candidates='bash zsh fish --json -h --help'",
    );
  });

  test("renders nested Zsh commands with descriptions", () => {
    const output = renderCompletion(fixture(), "zsh");
    expect(output).toStartWith("#compdef asana-cli\n");
    expect(output).toContain("'get:read a task'\\''s details'");
    expect(output).toContain(
      "_describe -t commands 'commands' command_candidates",
    );
    expect(output).toContain("'bash:completion shell'");
    expect(output).toContain(
      "'tasks/get:--completed') value_candidates=('true:value' 'false:value')",
    );
    expect(output).toContain("'tasks/get:--completed='*)");
    expect(output).toContain("compset -P '*='");
    expect(output).toContain("'tasks/get:--file')");
    expect(output).toContain("'tasks/get:--file='*)");
  });

  test("renders Fish commands, options, and context function", () => {
    const output = renderCompletion(fixture(), "fish");
    expect(output).toContain("function __asana_cli_context_is");
    expect(output).toContain(
      "complete -c asana-cli -f -n '__asana_cli_context_is tasks' -a 'get'",
    );
    expect(output).toContain(
      "complete -c asana-cli -n '__asana_cli_context_is tasks/get' -l 'file' -r -F",
    );
    expect(output).toContain(
      "complete -c asana-cli -f -n '__asana_cli_context_is tasks/get' -l 'json'",
    );
    expect(output).not.toContain(
      "complete -c asana-cli -n '__asana_cli_context_is workspaces/list' -l 'fields'",
    );
    expect(output).toContain("-l 'completed' -r -a 'true false'");
    expect(output).toContain(
      "complete -c asana-cli -f -n '__asana_cli_context_is completion' -a 'zsh'",
    );
  });
});

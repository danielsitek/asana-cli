---
name: asana-cli
description: Asana CLI (asana-cli) command reference and safety workflow — use when reading, creating, updating, or commenting on Asana tasks, resolving asana-cli configuration/aliases, or triaging an asana-cli failure.
allowed-tools: Bash(asana-cli *) Bash(gh issue list *) Bash(gh issue create *)
---

`asana-cli` is already installed; invoke it directly. Every Asana operation goes through it — never call the Asana REST API, an SDK, a MCP, or curl to route around a missing command; that risks handling `ASANA_CLI_TOKEN` outside its one sanctioned path (the CLI never accepts the token as an argument). If a workflow needs something the CLI doesn't expose, stop and use the closest supported primitive, or follow "Filing a CLI issue" below with the `enhancement` label instead of working around it.

## Read before write

Before any command that mutates a task (`tasks update`, `tasks create`, `tasks comment`), read the target first with `asana-cli tasks get <id> --json`. Confirm the returned `gid`, `name`, and the specific field you're about to change match what you intend. Decide the exact fields from that read, then issue one `update`/`create`/`comment` call — don't narrow the change mid-write.

## Config aliases can write as a side effect

`--my-section=@alias` and `--custom-field=@alias:value` resolve through the gitignored, per-user `.asana-cli.local.json`. On a machine without it, aliases fail. Both `config init --local --write-gitignore` and `config resolve my-tasks` re-discover and overwrite that file's `myTasks` block — neither is read-only; run one before relying on an alias. To inspect aliases already on disk without touching them, read the file directly or use `config get myTasks.<key> --source` / `config show --sources`.

## Supported workflows

Every `<id>` below must be a digit-only GID or a URL of the exact form `https://app.asana.com/0/<project>/<task>[/f]` — other Asana URL shapes fail with exit 2.

| Goal                                                | Command                                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Show authenticated user                             | `asana-cli whoami`                                                                                                                                                                                           |
| Init shared config (repo-wide)                      | `asana-cli config init --shared --workspace=<gid>`                                                                                                                                                           |
| Init local config (per-user aliases)                | `asana-cli config init --local --write-gitignore`                                                                                                                                                            |
| Inspect resolved config                             | `asana-cli config show --json --sources`, `config get <key> --source`                                                                                                                                        |
| Re-discover My Tasks aliases (writes local config)  | `asana-cli config resolve my-tasks`                                                                                                                                                                          |
| Read a task                                         | `asana-cli tasks get <id> --json [--fields=...]`                                                                                                                                                             |
| Read comments (bounded)                             | `asana-cli tasks comments <id> --max=<n> [--all] --json`                                                                                                                                                     |
| Update a task                                       | `asana-cli tasks update <id> --name=... --notes=...\|--notes-file=<path\|-> --assignee=me\|<gid>\|null --due-on=YYYY-MM-DD\|null --completed=true\|false --my-section=@alias --custom-field=@alias:<number>` |
| Create a subtask (`--parent` and `--name` required) | `asana-cli tasks create --parent=<id> --name=... [same mutation flags]`                                                                                                                                      |
| Comment on a task                                   | `asana-cli tasks comment <id> "text"` or `--file=<path\|->`                                                                                                                                                  |

Notes: `--notes` and `--notes-file` are mutually exclusive; notes are replaced wholesale, never appended. `--custom-field` is repeatable and numeric-only. `--json` and `--fields` may appear before or after the subcommand; `--fields` only applies to `tasks get`/`comments`/`comment`. On `tasks create`, `--my-section`/`--custom-field` additionally require `--assignee=me` or a digit-only GID on that same call, or the command fails with exit 2.

## JSON envelope, stderr, and exit codes

With `--json`, successful reads and writes print `{ "data": ..., "meta": ... }` to stdout. Diagnostics never go to stdout on success.

Errors are always JSON on stderr, regardless of `--json`: `{ "error": { "code": "...", "message": "..." } }`. One exception: a partial multi-stage write (exit 1 below) prints its `{ completed, failed, message }` detail to **stdout**, not stderr — check exit code, not which stream has content, to detect a partial write.

| Code | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| 0    | success                                                                                       |
| 1    | partial write — only from `tasks create`, `config init --local`, or `config resolve my-tasks` |
| 2    | invalid usage or configuration                                                                |
| 3    | authentication/authorization failure                                                          |
| 4    | Asana API, not-found, or network error                                                        |
| 5    | rate-limit or retry exhaustion                                                                |
| 6    | unexpected internal CLI error                                                                 |

## Filing a CLI issue

File against `danielsitek/asana-cli` for two cases only:

- **Bug** (`--label bug`): exit 6, or exit 4/5 on a command that this skill's own reference confirms was well-formed. Exit 2 and 3 mean fix the command or the environment — do not file for those.
- **Feature request** (`--label enhancement`): the workflow needs something no command or flag in "Supported workflows" covers — don't work around it by calling the Asana API/SDK/MCP/curl directly.

1. For a bug, rerun the exact failing command once to confirm the failure is deterministic, not a network blip. Skip this step for a feature request — there's nothing to rerun.
2. Search for a duplicate: `gh issue list --repo danielsitek/asana-cli --search "<key phrase>" --state all` (error message for a bug, the missing capability in your own words for a feature request).
3. If none matches, draft the body:
   - Bug: the exact command run (the token is never in argv, so it's safe to include verbatim), `asana-cli --version` output, OS, the stderr JSON error object verbatim, and expected vs. actual behavior.
   - Feature request: the task you were trying to accomplish, why no existing command/flag covers it, and the command/flag shape that would.
4. Confirm with the user before creating — filing a public issue is visible, hard-to-reverse shared state. Then: `gh issue create --repo danielsitek/asana-cli --label bug|enhancement --title "..." --body "..."`.

Completion criterion: either a new issue (bug or enhancement, with the evidence above) is filed, or an existing duplicate is linked back to the user instead.

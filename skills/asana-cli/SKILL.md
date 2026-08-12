---
name: asana-cli
description: Asana CLI (asana-cli) command reference and safety workflow — use when reading, creating, updating, or commenting on Asana tasks, resolving asana-cli configuration/aliases, or triaging an asana-cli failure.
allowed-tools: Bash(asana-cli *) Bash(gh issue list *) Bash(gh issue create *)
---

`asana-cli` is already installed; invoke it directly. Every Asana operation goes through it — never call the Asana REST API, an SDK, a MCP, or curl to route around a missing command; that risks handling `ASANA_CLI_TOKEN` outside its one sanctioned path (the CLI never accepts the token as an argument). If a workflow needs something the CLI doesn't expose, stop and use the closest supported primitive, or follow "Filing a CLI issue" below with the `enhancement` label instead of working around it.

## Project initialization

When asked to initialize `asana-cli` in a repository, complete the whole personal-ready setup unless the user explicitly requests a different default assignee or no default:

1. Resolve the workspace GID from the location the user names, or use `asana-cli workspaces list --json` if none is provided.
2. Run `asana-cli config init --shared --workspace=<gid>`.
3. Run `asana-cli config init --local --write-gitignore`.
4. Run `asana-cli config set defaultAssignee me` — `me` is preferred; no need to discover or store the user's numeric GID.
5. Verify the result with `asana-cli config get workspace.gid --source` and `asana-cli config get defaultAssignee --source`; report both resolved values and sources.

Treat initialization as incomplete if `defaultAssignee` was not set and verified.

## Read before write

Before `tasks update` or `tasks comment`, read the target first with `asana-cli tasks get <id> --json`. Before creating a subtask, read its `--parent` the same way. Confirm the returned `gid`, `name`, and relevant field match what you intend. A standalone create has no task to pre-read; confirm its explicit `--my-section` or `--project` destination instead. Decide the exact fields before issuing one write — don't narrow the change mid-write.

## Config aliases can write as a side effect

`--my-section=@alias` and `--custom-field=@alias:value` resolve through the gitignored, per-user `.asana-cli.local.json`. On a machine without it, aliases fail. Both `config init --local --write-gitignore` and `config resolve my-tasks` re-discover and overwrite that file's `myTasks` block — neither is read-only; run one before relying on an alias. To inspect aliases already on disk without touching them, read the file directly or use `config get myTasks.<key> --source` / `config show --sources`.

## Supported workflows

Every `<id>` below must be a digit-only GID or a URL of the exact form `https://app.asana.com/0/<project>/<task>[/f]` — other Asana URL shapes fail with exit 2.

| Goal                                               | Command                                                                                                                                                                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Show authenticated user                            | `asana-cli whoami`                                                                                                                                                                                                                              |
| Generate shell completion                          | `asana-cli completion bash\|zsh\|fish`                                                                                                                                                                                                          |
| List workspaces (find `<gid>` for config init)     | `asana-cli workspaces list --json`                                                                                                                                                                                                              |
| Init shared config (repo-wide)                     | `asana-cli config init --shared --workspace=<gid>`                                                                                                                                                                                              |
| Init local config (per-user aliases)               | `asana-cli config init --local --write-gitignore`                                                                                                                                                                                               |
| Inspect resolved config                            | `asana-cli config show --json --sources`, `config get <key> --source`                                                                                                                                                                           |
| Re-discover My Tasks aliases (writes local config) | `asana-cli config resolve my-tasks`                                                                                                                                                                                                             |
| Read a task                                        | `asana-cli tasks get <id> --json [--fields=...]`                                                                                                                                                                                                |
| Read comments (bounded)                            | `asana-cli tasks comments <id> --max=<n> [--all] --json`                                                                                                                                                                                        |
| Read only the newest N comments (bounded, exact)   | `asana-cli tasks comments <id> --max=<scan-cap> --latest=<n> --json`                                                                                                                                                                            |
| List tasks (bounded, one source)                   | `asana-cli tasks list --my-section=@alias\|--section=<gid>\|--project=<gid>\|--parent=<id> [--assignee=me\|<gid>] [--completed=true\|false] --max=<n> [--all] --json`                                                                           |
| Update a task                                      | `asana-cli tasks update <id> --name=... --notes=...\|--notes-file=<path\|-> --assignee=me\|<gid>\|null --due-on=YYYY-MM-DD\|null --completed=true\|false --my-section=@alias --custom-field=@alias:<number\|enum-option-gid\|exact-name\|null>` |
| Reparent or promote a task                         | `asana-cli tasks update <id> --parent=<gid>\|null`                                                                                                                                                                                              |
| Create a subtask                                   | `asana-cli tasks create --parent=<id> --name=... [same mutation flags]`                                                                                                                                                                         |
| Create a standalone task in My Tasks               | `asana-cli tasks create --my-section=@alias --name=... --assignee=me [same mutation flags]`                                                                                                                                                     |
| Create a standalone task in a project              | `asana-cli tasks create --project=<gid> --name=... [same mutation flags]`                                                                                                                                                                       |
| Comment on a task                                  | `asana-cli tasks comment <id> "text"` or `--file=<path\|->`                                                                                                                                                                                     |

Notes: `tasks comments --latest=<n>` returns only the globally newest `n` comments, newest first, and requires an explicit `--max=<scan-cap>`; it is mutually exclusive with `--all` and `--offset`. It succeeds only after scanning to source exhaustion within the cap — if the cap is reached while more stories are known, it fails with exit 5 (`scan_limit`) and returns no data; rerun with a higher `--max`. `tasks update --parent` is a dedicated single-write reparent — a GID or task URL moves it under that parent, `null` promotes it to top level, and it is exclusive with every other `tasks update` flag (a task cannot be its own parent). `tasks create` requires `--name` and at least one explicit destination: `--parent`, `--my-section`, or `--project`. `--project` accepts only a digit-only GID and cannot be combined with `--parent` or `--my-section`; `--parent` may be combined with `--my-section`. A standalone My Tasks create also requires configured `workspace.gid`. `--notes` and `--notes-file` are mutually exclusive; notes are replaced wholesale, never appended. `--custom-field` is repeatable and supports number values, enabled enum option GIDs or case-sensitive exact enum names, and `null`; enum GIDs take precedence over names. `--json` and `--fields` may appear before or after the subcommand; `--fields` applies to `tasks get`/`comments`/`comment`/`update`/`create`/`list`. On `tasks create`, `--my-section`/`--custom-field` require an assignable user — either `--assignee=me`/a digit-only GID on that same call, or a configured `defaultAssignee` (below) — or the command fails with exit 2. `tasks list` requires exactly one of `--my-section`/`--section`/`--project`/`--parent` (zero or multiple fails with exit 2); `--parent` accepts a task GID or URL and lists its direct subtasks. `--my-section` accepts only `@alias`, resolved and live-validated against My Tasks the same way as `tasks update --my-section`. `--assignee` and `--completed` (default `false`) filter client-side and work regardless of `--fields`. Default fields are `gid,name,completed,assignee.gid,assignee.name`.

## Personal default assignee (`tasks create` only)

`asana-cli config set defaultAssignee me|<gid>` stores a personal default in the gitignored local config. `tasks create` applies it only when `--assignee` is omitted; an explicit `--assignee`, including `--assignee=null`, always overrides it and skips the config lookup entirely. `tasks update` never reads or applies this default. Invalid values (anything other than `me` or a digit-only GID) are rejected with no file written; `--shared`/`--global` reject the key the same way.

## JSON envelope, stderr, and exit codes

With `--json`, successful reads and writes print a single compact, minified `{"data":...,"meta":...}` line to stdout. Diagnostics never go to stdout on success.

Errors are always compact, minified JSON on stderr, regardless of `--json`: `{"error":{"code":"...","message":"..."}}`. One exception: a partial multi-stage write (exit 1 below) prints its compact `{"completed":...,"failed":...,"message":...}` detail to **stdout**, not stderr — check exit code, not which stream has content, to detect a partial write.

| Code | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| 0    | success                                                                                       |
| 1    | partial write — only from `tasks create`, `config init --local`, or `config resolve my-tasks` |
| 2    | invalid usage or configuration                                                                |
| 3    | authentication/authorization failure                                                          |
| 4    | Asana API, not-found, or network error                                                        |
| 5    | rate-limit, retry exhaustion, or `tasks comments --latest` scan limit                         |
| 6    | unexpected internal CLI error                                                                 |

## Filing a CLI issue

File against `danielsitek/asana-cli` for two cases only:

- **Bug** (`--label bug`): exit 6, or exit 4/5 on a command that this skill's own reference confirms was well-formed. Exit 2 and 3 mean fix the command or the environment — do not file for those.
- **Feature request** (`--label enhancement`): the workflow needs something no command or flag in "Supported workflows" covers — don't work around it by calling the Asana API/SDK/MCP/curl directly.

Always write the title and body in English, regardless of the conversation language.

1. For a bug, rerun the exact failing command once to confirm the failure is deterministic, not a network blip. Skip this step for a feature request — there's nothing to rerun.
2. Search for a duplicate: `gh issue list --repo danielsitek/asana-cli --search "<key phrase>" --state all` (error message for a bug, the missing capability in your own words for a feature request).
3. If none matches, draft the body:
   - Bug: the exact command run (the token is never in argv, so it's safe to include verbatim), `asana-cli --version` output, OS, the stderr JSON error object verbatim, and expected vs. actual behavior.
   - Feature request: the task you were trying to accomplish, why no existing command/flag covers it, and the command/flag shape that would.
4. Confirm with the user before creating — filing a public issue is visible, hard-to-reverse shared state. Then: `gh issue create --repo danielsitek/asana-cli --label bug|enhancement --title "..." --body "..."`.

Completion criterion: either a new issue (bug or enhancement, with the evidence above) is filed, or an existing duplicate is linked back to the user instead.

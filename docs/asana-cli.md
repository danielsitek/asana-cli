# Asana CLI

Simple, non-interactive-first CLI for fast and reliable work with Asana. It returns a small, predictable data set by default and is designed to be equally usable from a terminal, shell script, or autonomous agent.

> This is the target product specification. The first implementation is the
> smaller My Tasks-first slice defined in [v0.1.md](v0.1.md).

Design principles:

- **Filter first** — never dump a whole project/workspace by accident; broad list commands require an explicit cap, and task search requires a narrowing filter.
- **Field selection** — default output is a small, explicit field set per resource (never relies on the API's own default fields); full data only via `--fields`.
- **Batch where the API actually allows it** — Asana's Batch API caps at **10 actions per HTTP request**. The CLI accepts many items per invocation and transparently chunks them into ≤10-action batches — one CLI command, but not one HTTP call once you pass 10 items.
- **Expensive reads are opt-in** — activity history and large listings default to one small page; the expensive path always needs an explicit flag and cap.
- **Scriptable by default** — every command has a non-interactive path suitable for humans and agents; prompts/editors are optional helpers, never the only way to complete a workflow. `--json` for machine consumption, human table otherwise; exit code reflects the real outcome, not just HTTP status (see [Output](#output)).
- **Predictable identifiers** — raw GIDs work everywhere; task and project commands additionally accept the supported Asana URL forms documented below. Ambiguous or unknown URL forms are rejected instead of guessed.

## Global flags

`--help` / `-h` — usage for the CLI itself or any subcommand, e.g. `asana-cli tasks create --help`.

`--version` / `-v` — prints the installed CLI version.

`--profile=<name>` — selects a named global profile for this invocation. `$ASANA_CLI_PROFILE` is the environment equivalent; the explicit flag wins.

`--json` and `--fields` are available on commands that return resources. Pagination flags are available only on list commands; unsupported flag/command combinations fail with exit code `2`.

### Identifiers and values

- Every ID accepts a raw digit-only GID.
- A task argument also accepts `https://app.asana.com/0/<project_gid>/<task_gid>` (optionally followed by `/f`) and extracts `<task_gid>`.
- A project argument or `--project` also accepts `https://app.asana.com/0/<project_gid>/list` and extracts `<project_gid>`.
- Only `https://app.asana.com` URLs with one unambiguous resource match are accepted. Section, team, user, tag, and custom-field values must be raw GIDs because their UI URLs are not stable resource identifiers.
- Dates use `YYYY-MM-DD`; booleans accept only `true` or `false`. The literal `null` clears nullable fields such as assignee or due date.
- Assignees accept `me`, a user GID, or an email address. If an email resolves to zero or multiple workspace users, the command fails instead of choosing one.

## Auth

`asana-cli login` — reads the personal access token from `$ASANA_CLI_TOKEN`, or one line from **stdin** when the variable is unset; never from a plain CLI argument (an argument would land in shell history). Stores it in the OS keychain (macOS Keychain / libsecret).

```
echo "$TOKEN" | asana-cli login
```

`asana-cli logout` — removes the stored token.

`asana-cli whoami` — resolves and prints the authenticated user (gid, name, email) and, where possible, the token's granted scopes. Asana scopes don't imply each other (`tasks:write` doesn't grant `tasks:read`; fetching nested fields like `assignee.email` needs `users:read`) — `whoami` is the cheap way to catch a missing scope before a real command fails on it.

For normal commands, `$ASANA_CLI_TOKEN` takes precedence over the keychain. This lets CI and agents authenticate without first running `login`.

## Config

Config is layered, highest precedence first:

1. CLI flags (`--project`, `--section`, `--team`, `--profile`, ...)
2. Narrow env overrides — `ASANA_CLI_TOKEN` (auth, see above), `ASANA_CLI_PROFILE`. Deliberately not a full config surface; env vars are for CI/automation, not routine settings.
3. **Project local** — `<git-root>/.asana-cli.local.json`, gitignored, personal.
4. **Project shared** — `<git-root>/.asana-cli.json`, committed, team-wide.
5. **Global user config** — `~/.config/asana-cli/config.json` (`$XDG_CONFIG_HOME` respected), cross-project defaults (e.g. which named profile to use in a directory with no project config at all).
6. Built-in defaults — output format, page limits, retry policy, default field sets. Never workspace/project/section IDs — those must come from an explicit config layer, so a fresh checkout with no config fails loudly on a scoped command instead of silently hitting the wrong Asana project.

Project config root is the **nearest git root** from cwd. Outside a git repo, project-level files are skipped entirely (no walking up an arbitrary directory tree) — only global config, flags, and env apply.

Workspace is intentionally config-only for normal commands. The CLI always resolves `workspace.gid` from config before calling workspace-scoped Asana endpoints; commands fail loudly if no workspace is configured. This keeps frequent task commands short and avoids agents spraying `--workspace` through every invocation.

`--workspace` is accepted only by `config init`. Passing it to any normal command is invalid usage and fails with exit code `2`. Inside a repo whose project config defines `workspace.gid`, one-off workspace switching is intentionally unsupported; change the project config or run the command outside that repo with a suitable global profile.

Configured project and team values are defaults only when a command needs a target, such as `tasks create`, `sections list`, or `projects create`. They are never silently added as filters to optional-filter commands such as `tasks search` or `projects`; a search with only `--assignee=me` is therefore workspace-wide. An explicit flag always wins over its configured target default.

`@<name>` resolves against `project.sections` anywhere a project-section value is accepted, including positional section IDs and `--before`/`--after`. `myTasks.sections` aliases resolve only for `--my-section`; `myTasks.customFields` aliases resolve for `--custom-field`.

### Shared vs. local: what goes where

The split exists because not everything in an Asana setup is team-shared — some of it is inherently per-user. Two concepts that look similar but aren't:

- **Project sections** — columns/sections on the team's shared Asana project board (e.g. this repo's "AI / Carrier Widget" project). Same for everyone on the team → **shared** config.
- **"My Tasks" sections** — the ToDo/In Progress/In Review/Done/Waiting sections inside *one person's own* "My Tasks" list. Every team member has their own My Tasks list with its own section gids → **local** config, never committed.

Mixing these up is an easy mistake (both are called "sections" in the Asana API) — the CLI keeps them under different config keys (`project.sections.*` vs `myTasks.sections.*`) so it's structurally impossible to commit someone's personal My Tasks IDs into the shared file by accident.

Shared, `.asana-cli.json` (committed):

```json
{
  "workspace": { "gid": "1201947864389005" },
  "project": {
    "gid": "1215855197447915",
    "sections": {
      "todo": "1215855197448001",
      "in_progress": "1215855197448002",
      "done": "1215855197448003"
    }
  },
  "team": { "gid": "1210787712320747" }
}
```

Local, `.asana-cli.local.json` (gitignored):

```json
{
  "profile": "work",
  "myTasks": {
    "userTaskListGid": "1213894072990299",
    "sections": {
      "todo": "1213894072991393",
      "in_progress": "1213894072991394",
      "in_review": "1213894072991395",
      "done": "1213894072991396",
      "waiting": "1216110087679028"
    },
    "customFields": {
      "hours_estimate": "1213894072991499"
    }
  }
}
```

`myTasks.userTaskListGid` doesn't need to be found and pasted by hand — it's per-user-per-workspace in Asana, so the CLI resolves it itself via `GET /users/me/user_task_list?workspace=<gid>` (needs the shared workspace gid to already be set) and caches the result locally. `config init --local` does this automatically and imports its section and custom-field aliases; `config resolve my-tasks` re-resolves the list, sections, and custom fields if they go stale.

### Merge semantics

- Deep merge, key by key, for plain objects — setting `myTasks.sections.in_review` locally overrides only that one key, not the whole `sections` map.
- Arrays replace wholesale, never concatenate — concatenation across layers produces config nobody can predict.
- Every layer is schema-validated independently before merging, then the merged result is validated again. Unknown keys **fail loudly** with file + JSON path (e.g. `.asana-cli.json: project.secctions is unknown — did you mean project.sections?`), never silently ignored — a typo'd section key silently resolving to "no section" is exactly the footgun this guards against.
- GIDs are validated as digit strings.
- Config files may never contain `token`/`accessToken`/`pat`-shaped keys in either layer — schema rejects them outright. Auth only ever lives in the OS keychain (see [Auth](#auth)).

### Commands

`asana-cli config init [--shared|--local] [--workspace=<gid>] [--project=<gid>] [--team=<gid>] [--profile=<name>] [--write-gitignore] [--no-input]` — creates config without requiring interaction when the needed flags are provided.

- `--shared` requires a workspace, either from `--workspace` or an existing lower-precedence config. Project and team are optional. When a project is supplied, the CLI validates that it belongs to the workspace, infers its team when `--team` is omitted, and imports its sections into `project.sections`.
- `--local` requires an effective workspace and authentication. It writes the optional profile, resolves the user's My Tasks list, and imports its sections into `myTasks.sections` and custom fields into `myTasks.customFields`.
- With neither flag, shared initialization runs first and local initialization second.
- Imported aliases are deterministic: lowercase the section name, replace each run of non-letter/digit characters with `_`, and trim leading/trailing `_` (for example, `In Review` becomes `in_review`). Unicode letters and digits are retained. Alias collisions are reported before writing; the user can then assign explicit aliases with `config set`.
- If a required value is missing and stdin is a TTY, the command may prompt. With `--no-input` or non-TTY stdin, it fails with exit code `2`. If `.asana-cli.local.json` is not already ignored, non-interactive local initialization requires `--write-gitignore` and fails with exit code `2` before writing otherwise. Interactive mode asks before changing `.gitignore`.

`asana-cli config set <key> <value> [--shared|--local|--global]` — writes to the shared file by default, *except* for keys under `myTasks.*`, which default to `--local` even without the flag — the common mistake to avoid is someone's personal My Tasks section gids ending up in the committed file.

`asana-cli config get <key> [--source]` — effective (merged) value; `--source` also prints which file it came from.

`asana-cli config show [--json] [--sources]` — full effective config, each field annotated with its source layer.

`asana-cli config edit [--shared|--local|--global]` — optional convenience command that opens the file in `$EDITOR`. Every setting it can change is also reachable through `config set`.

`asana-cli config doctor` — live-validates the resolved config against the API: workspace reachable, project belongs to workspace, configured `project.sections` gids actually belong to that project, configured `myTasks.sections` gids and `myTasks.customFields` definitions actually belong to the resolved My Tasks list, resolved My Tasks list belongs to the authenticated user in that workspace, token scopes are sufficient. Catches stale gids (project archived/recreated, section renamed/deleted, custom field removed, someone reordered their My Tasks sections) before a real command fails midway through a task move.

`asana-cli config resolve my-tasks` — re-resolves the authenticated user's My Tasks list and section aliases in the configured workspace, then updates local config.

`asana-cli config profile <name>` — creates an empty named profile in the global config. Populate it with `asana-cli config set <key> <value> --global --profile=<name>` (e.g. `config set workspace.gid <id> --global --profile=work`). Select it per invocation with `--profile=<name>` or `$ASANA_CLI_PROFILE`. Profiles provide global defaults, mainly outside git-configured projects; project files remain higher precedence even when a profile is explicitly selected.

## Tasks

`asana-cli tasks get <id>` — get a single task. Maps to [gettask](https://developers.asana.com/reference/gettask.md). Default fields: `gid,name,notes,completed,due_on,assignee.gid,assignee.name` — deliberately explicit, never "whatever the API defaults to," since that default has grown over time and isn't a token budget the CLI controls. `notes` is included because reading the assignment is the primary purpose of a bounded single-task read. Use `--fields` for more.

`asana-cli tasks update <id> <params...>` — update a task. At least one mutation flag is required. Plain fields map to [updatetask](https://developers.asana.com/reference/updatetask.md); memberships, parent, dependencies, and followers use their dedicated endpoints.

```
asana-cli tasks update 1215978111726134 --name="new task name" --due-on=2026-08-15 --assignee=me --completed=true
```

Supported flags: `--name`, `--notes`, `--notes-file=<path>|-`, `--assignee`, `--due-on`, `--start-on`, `--completed`, `--parent`, `--section=<gid>|@<name>`, `--my-section=<gid>|@<name>`, `--custom-field=(<gid>|@<name>):<value>` (repeatable). `--notes` and `--notes-file` are mutually exclusive; `--notes-file=-` reads UTF-8 notes from stdin. `tasks create` accepts the same set. Project section placement is supported at create time through Asana task memberships; My Tasks `assignee_section` is applied only after the task exists and is assigned to the authenticated user.

- `--section` — convenience flag, but under the hood it's not a plain field update: Asana models section membership as a project-membership operation, and a task can belong to more than one project/section. If the task isn't already in the target project, the CLI adds it there rather than failing. On `tasks create`, when `--project` is also present, the section must belong to it. `@<name>` (e.g. `--section=@in_review`) resolves against the shared config's `project.sections` map (see [Config](#config)) instead of requiring a raw gid every time.
- `--my-section` — maps to Asana's `assignee_section` field, i.e. moves the task within *your own* My Tasks list (this is the mechanism `asana-close-loop` uses to move a task to "In Review"). `@<name>` resolves against local config's `myTasks.sections` map. `assignee_section` is only readable/writable for the task's assignee. The CLI checks this precondition after applying any `--assignee` from the same command, so `--assignee=me --my-section=@in_review` works; another final assignee fails instead of moving someone else's My Tasks entry.
- `--custom-field=(<gid>|@<name>):<value>` — text, number, and date fields use their literal value; enum fields use an option GID; multi-enum fields use comma-separated option GIDs; `null` clears the field. A named alias resolves against `myTasks.customFields` and is valid only when the final assignee is the authenticated user. Before writing, the CLI validates the value against the applicable project or My Tasks definition.

`asana-cli tasks delete <id> --yes` — delete a task. Without `--yes`, the command refuses to run in non-interactive mode; in an interactive TTY it may ask for confirmation as a convenience.

`asana-cli tasks search` — filtered task search in the configured workspace. **This replaces a bare `tasks` list**, which is intentionally not supported without at least one narrowing filter (avoids dumping entire workspaces).

```
asana-cli tasks search --project=<id> --assignee=me --completed=false --due-before=2026-08-01 --text="customs"
```

Filters: `--project`, `--assignee`, `--completed`, `--due-before`/`--due-after`, `--created-before`/`--created-after`, `--text`, `--tag`, `--section`. Workspace is scope from config, not a narrowing filter; `tasks search` requires at least one explicit filter from this list. Filters have AND semantics. Because Asana treats `projects.any` plus `sections.any` as OR, the CLI validates that the section belongs to the requested project and sends only the section filter.

The command maps to [searchtasksforworkspace](https://developers.asana.com/reference/searchtasksforworkspace.md), which is **Premium-only** (can return `402 Payment Required`) and eventually consistent. A task just written may take roughly 10–60 seconds to appear. The normal default is `--limit=20` and the endpoint caps a request at 100. Search has no offset tokens: `--offset` is unsupported. `--all --max=<n>` follows Asana's documented workaround by repeatedly sorting on creation time, advancing the creation-time boundary, and de-duplicating GIDs; results can still change while a search is running.

On `402`, the CLI falls back to [gettasks](https://developers.asana.com/reference/gettasks.md) only when there is a bounded base filter: `--section`, `--project`, `--tag`, or `--assignee` (with the configured workspace). When several are present, base-filter priority is `--section`, `--project`, `--tag`, then `--assignee`; all others are applied client-side. `--text` cannot be reproduced and fails with `Premium search required for this filter` and exit code `4`. The fallback scans up to 500 base tasks by default, or `--max=<n>` when provided. Without `--all`, it returns up to `--limit=<n>` matches; with `--all`, it returns every match found within the scan cap. On this fallback path, `--max` always means the internal scan cap. If the scan cap is reached first, human output warns that results may be incomplete and JSON sets `meta.scan_truncated` to `true`.

`asana-cli tasks create` — create one or more tasks. A single task requires `--name` and a destination from `--project`, configured `project.gid`, `--section`, or `--parent`. An explicit `--project` wins over configured `project.gid`. With `--file`, an item's own `"project"` wins; the command's `--project`, then configured `project.gid`, backfills only items that omit it. `--file` is mutually exclusive with per-task mutation flags other than this fallback `--project`.

```
asana-cli tasks create --project=<id> --name="Task name" --assignee=me --due-on=2026-08-15
asana-cli tasks create --project=<id> --file=tasks.json   # chunked into ≤10-action Batch API calls
```

`asana-cli tasks update-bulk --file=updates.json` — same chunking as above. Batch API returns `HTTP 200` even when individual inner actions failed, so the CLI always inspects each inner result and never treats the outer HTTP status as success — see [Output](#output) for the result shape.

### Bulk file formats

Bulk files are UTF-8 JSON. Object keys are the long CLI flag names without `--`; repeatable flags use arrays. Every file is schema-validated in full, including unknown keys, before the first API write.

`tasks create --file=tasks.json` accepts an array:

```json
[
  {
    "name": "Prepare release notes",
    "project": "1215855197447915",
    "assignee": "me",
    "due-on": "2026-08-15",
    "section": "@in_progress",
    "follower": ["1200123456789012"]
  }
]
```

`tasks update-bulk --file=updates.json` accepts the same objects with a required `id`; `name` is optional:

```json
[
  { "id": "1215978111726134", "completed": true, "section": "@done" }
]
```

`projects create --name="..." --file=structure.json` accepts a structure object. Task objects use the same keys as `tasks create`, except their project and section come from the containing section:

```json
{
  "sections": [
    {
      "name": "To do",
      "tasks": [
        { "name": "First task", "assignee": "me" }
      ]
    }
  ]
}
```

### Subtasks, dependencies, followers

Exposed as flags on `tasks create` / `tasks update <id>` for convenience, but each maps to a **separate Asana endpoint**, not a field on the task payload:

- `--parent=<id>` — creates a subtask or changes its parent through the subtask/set-parent endpoint; `parent` cannot be modified by the normal task PUT
- `--subtask="name"` (repeatable, one level only) — creates a separate child through the subtask endpoint
- `--depends-on=<id>` / `--blocks=<id>` (repeatable) — dependency endpoints
- `--follower=<user>` (repeatable, add) / `--unfollow=<user>` (remove) — followers endpoint

This matters for batch/bulk: a dependency or follower relation targeting a task created earlier **in the same bulk call** can't be resolved within that call (batch actions run independently, with no guaranteed order and no way to reference another action's output). The CLI stages this automatically — creates the tasks first, waits for their gids, then issues a second call for relations — but a plan that assumes one atomic round trip for "create tasks + wire up dependencies" is wrong.

### Comments & activity

`asana-cli tasks comment <id> "text"` — add a comment. `--file=<path>|-` reads a UTF-8 comment from a file or stdin and is mutually exclusive with the positional text. Maps to [createstoryfortask](https://developers.asana.com/reference/createstoryfortask.md).

`asana-cli tasks comments <id>` — comments only. It filters the Stories endpoint client-side, returns up to 20 comments while scanning at most 100 stories by default, and preserves API order. `--max=<n>` changes the scan cap; `--all` requires `--max`. Reaching the scan cap sets `meta.scan_truncated=true`.

`asana-cli tasks stories <id>` — activity feed (comments + system events: assignment, completion, due-date changes, project adds). Maps to [getstoriesfortask](https://developers.asana.com/reference/getstoriesfortask.md). The default is the first API page with `--limit=20`, preserving API order; Asana does not document that page as the most recent stories. Use `--offset=<token>` for the next page or `--all --max=<n>` for a bounded complete traversal.

## Projects

`asana-cli projects` — list projects in the configured workspace with `--limit=20`; an explicit `--team` narrows the listing. Use `--all --max=<n>` for a broader project inventory.

`asana-cli projects <id>` — get project details. `--sections` includes section gids (needed before moving a task with `tasks update <id> --section=<gid>`).

`asana-cli projects create --name="..." [--team=<id>]` — create a project. Team comes from the flag or configured `team.gid`; the command fails if neither exists.

`asana-cli projects create --name="..." --file=structure.json` — create a project with sections and tasks. This is **not** one atomic call: it's a staged sequence (create project → create sections → create tasks per section, each task batch chunked at ≤10). It is not transactional — if a later stage fails, earlier stages already exist in Asana. The CLI reports exactly what succeeded and what didn't (e.g. "project + 3/4 sections created, section 'QA' failed: <reason>") so the user can retry just the failed part instead of guessing at partial state.

### Sections

`asana-cli sections list [--project=<id>]` — list sections for a project. Project comes from the flag or configured `project.gid`. Maps to [getsectionsforproject](https://developers.asana.com/reference/getsectionsforproject.md).

`asana-cli sections get <id>` — get a single section. Maps to [getsection](https://developers.asana.com/reference/getsection.md).

`asana-cli sections create --name="..." [--project=<id>]` — create a section. Project comes from the flag or configured `project.gid`. Maps to [createsectionforproject](https://developers.asana.com/reference/createsectionforproject.md). `--before=<section-id>` / `--after=<section-id>` to control position, otherwise appended at the end.

`asana-cli sections update <id> --name="..."` — rename a section. Maps to [updatesection](https://developers.asana.com/reference/updatesection.md).

`asana-cli sections delete <id> --yes` — delete a section (tasks in it are not deleted, just unsectioned). Without `--yes`, non-interactive execution is refused and a TTY may ask for confirmation. Maps to [deletesection](https://developers.asana.com/reference/deletesection.md).

`asana-cli sections add-task <id> <task-id>` — move/insert a task into a section. Maps to [addtaskforsection](https://developers.asana.com/reference/addtaskforsection.md). `--before=<task-id>` / `--after=<task-id>` for placement within the section; equivalent shortcut also available as `tasks update <id> --section=<section-id>`.

`asana-cli sections reorder <id> --project=<id>` — reorder sections within a project. Maps to [insertsectionforproject](https://developers.asana.com/reference/insertsectionforproject.md), `--before=<section-id>` / `--after=<section-id>`. `--project` may be omitted only when `project.gid` is configured.

## Users / workspace

Both commands below use the configured workspace. Users map to `GET /users?workspace=<gid>` and teams map to `GET /workspaces/{workspace_gid}/teams`.

`asana-cli users search --text=<name-or-email>` — resolve a name/email to a gid before assigning. Since Asana has no server-side user search here, the CLI scans up to 500 workspace users by default, or `--max=<n>`, and outputs up to `--limit=20` matches. If the scan cap is reached, human output warns and JSON sets `meta.scan_truncated=true`; an empty truncated result is inconclusive, not "user not found." An exact email found during the scan wins. Otherwise zero or multiple matches are represented explicitly and never auto-selected.

`asana-cli users list` — first 20 workspace users. A complete listing requires `--all --max=<n>`.

`asana-cli teams` — list teams in the configured workspace.

## Custom fields

`asana-cli custom-fields list [--project=<id>]` — list the custom field definitions on a project, using configured `project.gid` when omitted: gid, name, type, and (for enum/multi-enum fields) each option's name + gid.

`teams` and `custom-fields list` use the common list defaults (`--limit=20`, `--offset`, or `--all --max=<n>`).

## Output

- Default: compact human-readable table. Every read/list command uses a small, explicit default field set rather than the API's own defaults. Mutating commands return `gid`, `name` when available, and every field explicitly changed by the command unless `--fields` overrides that.
- Default read/list field sets:
  - `tasks get`: `gid,name,notes,completed,due_on,assignee.gid,assignee.name`
  - `tasks comments`: `gid,created_at,text,created_by.gid,created_by.name`
  - `tasks search`: `gid,name,completed,due_on,assignee.gid,assignee.name,permalink_url`
  - `tasks stories`: `gid,created_at,type,text,created_by.gid,created_by.name`
  - `projects`: `gid,name,archived,team.gid,team.name`
  - `projects <id>`: `gid,name,archived,team.gid,team.name,permalink_url`
  - `sections list`: `gid,name`
  - `sections get`: `gid,name,project.gid,project.name`
  - `users search` / `users list`: `gid,name,email`
  - `teams`: `gid,name`
  - `custom-fields list`: `gid,name,resource_subtype,enum_options.gid,enum_options.name`
- `--fields=name,due_on,notes` — explicit field selection, equivalent to Asana API `opt_fields`. Naming rule: CLI flags are kebab-case (`--due-on`), but values passed to `--fields` are Asana's own field names (dotted/snake, e.g. `assignee.email`) since they pass straight through to `opt_fields` — the CLI does not translate between the two.
- `--json` — stable JSON for scripts and agents, with no status prose on stdout. Success is `{ "data": <object|array>, "meta": { ... } }`; `meta` includes applicable pagination fields and is otherwise empty. `next_offset` is the API token for another page, `truncated=true` means the CLI stopped at an explicit `--max` while more results were known to remain, and `scan_truncated=true` means a client-side scan cap was reached before the source was exhausted. Exit code `1` still emits this shape on stdout with per-item/stage statuses and errors. Exit codes `2`–`6` emit `{ "error": { "code": "<stable_code>", "message": "...", "details": ... } }` to stderr and nothing to stdout when no partial write occurred.
- List commands default to `--limit=20`; Asana page size is capped at 100. A value outside `1..100` fails with exit code `2` instead of being silently clamped. `--offset=<token>` requests a known next page where the underlying endpoint supports offsets. `--all` auto-pages but always requires `--max=<n>`. `tasks search` uses the special no-offset behavior described in its section.
- Batch/bulk `data` is an array in input order. Each item is `{ "index": <n>, "gid": "<gid>"|null, "status": "ok"|"failed", "error": <object|null>, "retryable": <boolean> }`; `meta` also contains `requested`, `succeeded`, and `failed`. The CLI inspects every inner Batch API result even when the outer HTTP status is `200`.
- `projects create --file` uses the same item result fields but replaces `index` with an input `path`, such as `project`, `sections[0]`, or `sections[0].tasks[1]`, so every nested result maps back to the structure file.
- Human bulk output prints one summary line (`N succeeded, M failed`) followed by a compact table of failed input indexes/paths and reasons. Use `--json` when every per-item result is needed.
- Multi-step operations run in documented dependency order: create/update the base resource first, then memberships/parent, then dependencies/followers/subtasks. A later failure never rolls back prior Asana writes; the result identifies every completed and failed stage.
- Exit codes: `0` success; `1` at least one requested item or stage failed after another succeeded; `2` invalid CLI usage or config validation failure; `3` authentication/authorization failure; `4` Asana API error or not found before any write succeeded; `5` rate limit/retry exhaustion before any write succeeded; `6` unexpected internal CLI error. Exit code `1` takes precedence whenever a command has already made a successful write and cannot complete all requested work.

## Rate limits & reliability

- Respect `Retry-After` on `429` responses; bounded retries with backoff, not a tight retry loop.
- Keep request concurrency conservative and configurable: `network.concurrency` defaults to `4` and `network.maxRetries` defaults to `3`. Both can be changed in config; the CLI does not hard-code Asana's current account limits.
- `tasks search` sits behind a separate, stricter rate limit than regular CRUD endpoints — the CLI throttles it independently instead of sharing a budget with everything else.

# Asana CLI

[![CI](https://img.shields.io/github/actions/workflow/status/danielsitek/asana-cli/ci.yml?branch=main&label=CI)](https://github.com/danielsitek/asana-cli/actions/workflows/ci.yml)
[![Codacy Badge](https://app.codacy.com/project/badge/Grade/e02d5c2275c145faad4146797c85b809)](https://app.codacy.com/gh/danielsitek/asana-cli/dashboard?utm_source=gh&utm_medium=referral&utm_content=&utm_campaign=Badge_grade)
[![Release](https://img.shields.io/github/v/release/danielsitek/asana-cli)](https://github.com/danielsitek/asana-cli/releases)
[![License: MIT](https://img.shields.io/github/license/danielsitek/asana-cli)](LICENSE)

Fast, script-friendly CLI for working with Asana from a terminal or autonomous agent. It favors explicit fields, bounded reads, deterministic JSON, and honest reporting of partial writes.

## Install

### macOS (Homebrew)

```sh
brew install danielsitek/homebrew-tap/asana-cli
```

### Direct archive (macOS, Linux, WSL2)

Download the archive for your platform from the release assets, verify its
checksum, then install the binary:

| Platform              | Architecture   | Archive                                      |
| --------------------- | -------------- | -------------------------------------------- |
| macOS (Apple Silicon) | arm64          | `asana-cli-v0.4.0-darwin-arm64.tar.gz`       |
| macOS (Intel)         | x64            | `asana-cli-v0.4.0-darwin-x64.tar.gz`         |
| Linux / WSL2 (x86_64) | x64 (baseline) | `asana-cli-v0.4.0-linux-x64-baseline.tar.gz` |
| Linux / WSL2 (arm64)  | arm64          | `asana-cli-v0.4.0-linux-arm64.tar.gz`        |

```sh
curl -LO https://github.com/danielsitek/asana-cli/releases/download/v0.4.0/asana-cli-v0.4.0-<target>.tar.gz
curl -LO https://github.com/danielsitek/asana-cli/releases/download/v0.4.0/SHA256SUMS

# Linux / WSL2: verify the checksum before installing
grep " asana-cli-v0.4.0-<target>.tar.gz$" SHA256SUMS | sha256sum -c -

# macOS: use the system-provided checksum utility instead
grep " asana-cli-v0.4.0-<target>.tar.gz$" SHA256SUMS | shasum -a 256 -c -

tar -xzf asana-cli-v0.4.0-<target>.tar.gz
sudo install -m 0755 asana-cli /usr/local/bin/asana-cli
```

Replace `<target>` with the value from the table above (e.g. `darwin-arm64`).
To upgrade, repeat these steps with the newer archive.

macOS binaries carry an ad-hoc signature (no Developer ID signing or
notarization yet); Gatekeeper may require an explicit approval on first run.

### Uninstall

```sh
brew uninstall asana-cli                         # Homebrew package
brew untap danielsitek/homebrew-tap              # optional tap cleanup
sudo rm /usr/local/bin/asana-cli                 # direct archive install
```

## AI agent skill

This repository includes a ready-to-use skill that teaches AI agents how to
configure and operate `asana-cli` safely. Install it with skills.sh:

```sh
npx skills@latest add danielsitek/asana-cli
```

## Authentication

Asana CLI reads the token only from `ASANA_CLI_TOKEN`. It never accepts a
token as a CLI argument, writes it to a shell profile, or loads it
automatically from a `.env` file.

### Create a personal access token

1. Open the [Asana developer console](https://app.asana.com/0/my-apps), or in
   Asana open **Settings → Apps → View developer console**.
2. Open **Personal access tokens**, create a token, and give it a recognizable
   description such as `asana-cli`.
3. Copy the token when Asana displays it and store it as a secret.

The account must be able to read/edit the relevant tasks, access its My Tasks
list and sections, read custom-field definitions, and read/write comments.
See Asana's [PAT guide](https://developers.asana.com/docs/personal-access-token).

### Set the token

For one shell invocation:

```sh
ASANA_CLI_TOKEN="your-token" asana-cli whoami
```

For persistent use:

```sh
echo 'export ASANA_CLI_TOKEN="your-token"' >> ~/.zshrc
```

Never commit the token; if exposed, revoke it in the Asana developer console
and create a replacement.

## Configuration

```sh
# Discover workspace GIDs
asana-cli workspaces list --json

# Initialize shared config (.asana-cli.json, committed)
asana-cli config init --shared --workspace=1201947864389005

# Resolve personal My Tasks config (.asana-cli.local.json, gitignored)
asana-cli config init --local --write-gitignore
```

`config init --local` and `asana-cli config resolve my-tasks` both
re-discover and overwrite the entire `myTasks` block in
`.asana-cli.local.json`; neither is read-only. Rerun `config resolve
my-tasks` after sections or custom fields change in Asana.

Example `.asana-cli.local.json`:

```json
{
  "myTasks": {
    "userTaskListGid": "1213894072990299",
    "sections": {
      "in_progress": "1213894072991394",
      "in_review": "1213894072991395"
    },
    "customFields": {
      "hours_estimate": "1213894072991499"
    }
  }
}
```

Inspect resolved configuration and its source:

```sh
asana-cli config show --json --sources
asana-cli config get myTasks.userTaskListGid --source
```

Set a default assignee for `tasks create` (ignored by `tasks update`):

```sh
asana-cli config set defaultAssignee me
asana-cli config set defaultAssignee 1201947864389005 --local
```

Value must be `me` or a digit-only user GID; an explicit `--assignee`
(including `--assignee=null`) always overrides it.

## Usage

Run `asana-cli <command> --help` for the full flag reference. Common
workflows:

```sh
# Read a task, including its description
asana-cli tasks get 1215978111726134

# Read only the newest 3 comments, newest first, scanning up to 200 stories
asana-cli tasks comments 1215978111726134 --max=200 --latest=3

# List incomplete tasks in a My Tasks section assigned to you
asana-cli tasks list --my-section=@in_progress --assignee=me

# List projects in the configured workspace
asana-cli projects list

# Read one project's metadata
asana-cli projects get 1215978111726134

# List the direct subtasks of a parent task
asana-cli tasks list --parent=1215978111726134

# Move the task in your personal My Tasks board and comment
asana-cli tasks update 1215978111726134 --my-section=@in_review
asana-cli tasks comment 1215978111726134 "Ready for review"

# Move a task into any project section
asana-cli tasks update 1215978111726134 --section=1201947864389010

# Replace a description safely from a file
asana-cli tasks update 1215978111726134 --notes-file=task-description.md

# Create a subtask, assign it to yourself, and set a numeric custom field
asana-cli tasks create \
  --parent=1215978111726134 \
  --name="Implement the change" \
  --assignee=me \
  --my-section=@in_progress \
  --custom-field=@hours_estimate:4

# Create a standalone task in a project
asana-cli tasks create \
  --name="Prepare the release" \
  --project=1201947864389005

# Create a standalone task directly in a project section
asana-cli tasks create \
  --name="Review the release" \
  --section=1201947864389010
```

## Command reference

A task `<id>` (positional, and `--parent`) accepts a digit-only GID or a URL
of the exact form `https://app.asana.com/0/<project>/<task>[/f]`; other URL
shapes fail with exit 2. `--section` and `--project` accept only digit-only
GIDs. `--my-section` accepts a digit-only GID or `@<alias>` on `tasks create`
and `tasks update`; on `tasks list` it accepts only `@<alias>`.

See [Safety and mutation contract](#safety-and-mutation-contract) below for
bounded-read caps, write-retry behavior, and partial-write reporting.

### Mutation options (`tasks create` / `tasks update`)

Both commands accept the same mutation flags:

- `--name=<text>`
- `--notes=<text>` / `--notes-file=<path|->` — mutually exclusive; both
  replace the entire description, never append. `-` reads from stdin.
- `--assignee=me|<gid>|null`
- `--due-on=<YYYY-MM-DD>|null`
- `--completed=true|false`
- `--my-section=<gid>|@<alias>` — place or move within My Tasks
- `--section=<gid>` — place or move in any project section
- `--custom-field=(<field-gid>|@<alias>):<value>` — repeatable, see
  [Custom fields](#custom-fields---custom-field) below

`--my-section` or `--custom-field` requires the final assignee to be the
authenticated user, checked after all other flags are applied: on `tasks
create` this is an explicit `--assignee=me|<gid>` or a configured
`defaultAssignee` (see [Configuration](#configuration)); on `tasks update`
without `--assignee`, it's the task's existing assignee. Otherwise the
command fails with exit 2.

### `tasks create`

- Requires `--name` and at least one destination:
  - `--parent=<gid-or-url>` — subtask
  - `--my-section=<gid>|@<alias>` — standalone My Tasks task (uses configured `workspace.gid`)
  - `--section=<gid>` — standalone task in the section's inferred project
  - `--project=<gid>` — standalone project task
- `--parent` and `--my-section` may be combined. `--section` is exclusive with
  every other destination; `--project` cannot be combined with `--parent` or
  `--my-section`.

### `tasks update`

- Applies the mutation options above for a normal update.
- `--project=<gid>` adds the task to a project without changing its parent.
  It is a dedicated single-write operation and cannot be combined with any
  other update flag.
- `--section=<gid>` is a dedicated single-write placement operation and cannot
  be combined with any other update flag. It does not use My Tasks
  configuration or impose an assignee requirement.
- `--parent=<gid>|null` reparents instead of updating:
  - GID or task URL — moves it under that parent
  - literal `null` — promotes it to a top-level task
  - dedicated single-write operation, cannot be combined with any other `tasks update` flag; a task cannot be its own parent.

### `tasks list`

- Requires exactly one source:
  - `--my-section=@<alias>` — a My Tasks section (live-validated the same way as `tasks update --my-section`)
  - `--section=<gid>` — any section
  - `--project=<gid>` — a project
  - `--parent=<gid-or-url>` — a task's direct subtasks
- Filters apply client-side, so they work even when `--fields` omits the field:
  - `--assignee=me|<gid>`
  - `--completed=true|false` (default `false`)
- Bounded like `tasks comments`: default scan cap 100, result cap 20; `--max=<n>` raises the scan cap; `--all` (requires `--max`) removes the result cap.
- Default fields: `gid,name,completed,assignee.gid,assignee.name`.

### `projects list`

- Lists projects in `--workspace=<gid>`, defaulting to configured `workspace.gid`.
- Bounded like `tasks list`: default scan cap 100, result cap 20; `--max=<n>` raises the scan cap; `--all` (requires `--max`) removes the result cap.

### `projects get`

- Reads one project by digit-only GID.
- Default fields: `gid,name,archived`; use `--fields=<comma-separated>` to select others.

### `projects sections`

- `projects sections <gid>` lists visible sections in API order.
- Bounded like `projects list`: default scan cap 100, result cap 20; `--max=<n>` raises the scan cap; `--all` (requires `--max`) removes the result cap.
- Default fields: `gid,name`; use `--fields=<comma-separated>` to select others.

### `projects custom-fields`

- `projects custom-fields <gid>` lists project custom-field settings in API order.
- Defaults: `gid,is_important,custom_field.gid,custom_field.name,custom_field.resource_subtype`.
- Bounded like `projects list`: default scan cap 100, result cap 20; `--max=<n>` raises the scan cap; `--all` (requires `--max`) removes the result cap.
- `gid` identifies the setting; `custom_field.gid` identifies the field definition. Use `custom_field.enum_options.gid,name,enabled` to select enum options.

### Comments (`tasks comment` / `tasks comments`)

- `tasks comment <id> "text"` or `--file=<path|->` posts a comment; `--file=-` reads from stdin.
- `tasks comments <id> [--max=<n>] [--all]` reads existing comments, bounded the same way as `tasks list`: default scan cap 100, result cap 20; `--max=<n>` raises the scan cap; `--all` (requires `--max`) removes the result cap.

### Custom fields (`--custom-field`)

- Syntax: `--custom-field=(<field-gid>|@<alias>):<value>`, repeatable.
- Writes number or enum custom fields.
- Number values use finite integer or dot-decimal syntax.
- Enum values resolve by GID first, then by case-sensitive exact name; invalid or ambiguous names list the valid options.
- `null` clears either type.
- Field definitions and options are live-validated before writing.

### Output (`--json` / `--fields`)

- `--fields=<comma-separated>` selects explicit Asana fields; supported on `tasks get`, `comments`, `comment`, `update`, `create`, `list`, `projects get`, `projects sections`, and `projects custom-fields`.
- `tasks create`/`tasks update` always include `gid` in the response, even if `--fields` omits it.
- `--json` and `--fields` may appear before or after the subcommand.
- On success, `--json` prints one compact, minified line: `{"data":...,"meta":...}`.
- Errors are compact JSON on stderr — `{"error":{"code":"...","message":"..."}}` — regardless of `--json`. Exception: a failed multi-step `tasks create` (exit 1) prints its `{"completed":...,"failed":...,"message":...}` partial-result detail to **stdout** — see [Safety and mutation contract](#safety-and-mutation-contract).

## Shell completion

Homebrew installs command completion for Bash, Zsh, and Fish automatically.
Restart the shell after installing or upgrading `asana-cli`.

For a direct archive installation, generate the completion script for the
current shell. Zsh:

```sh
mkdir -p ~/.zfunc
asana-cli completion zsh > ~/.zfunc/_asana-cli
```

Add the completion directory before `compinit` in `~/.zshrc`:

```sh
fpath=(~/.zfunc $fpath)
autoload -Uz compinit
compinit
```

Bash with `bash-completion` installed:

```sh
asana-cli completion bash > ~/.asana-cli-completion.bash
```

Source it from `~/.bashrc`:

```sh
source ~/.asana-cli-completion.bash
```

Fish:

```sh
mkdir -p ~/.config/fish/completions
asana-cli completion fish > ~/.config/fish/completions/asana-cli.fish
```

Completion is generated locally and never reads configuration, authentication
credentials, or the Asana API.

## Safety and mutation contract

- The CLI is non-interactive; missing required input fails immediately.
- Reads are bounded; complete traversal requires `--max=<n>` with `--all` for
  `tasks comments`, `tasks list`, `projects list`, and `projects sections`.
- `tasks comments --latest=<n>` returns only the globally newest `n` comments,
  newest first, and requires an explicit `--max=<scan-cap>`; it is mutually
  exclusive with `--all` and `--offset`. If the cap is reached before the
  source is fully scanned, it fails and returns no data — rerun with a higher
  `--max`.
- `POST` is never retried after an ambiguous timeout, network error, or 5xx —
  this avoids duplicating a task, subtask, or comment.
- Multi-step writes (such as `tasks create` with My Tasks placement) validate
  every input before the first write, then report every completed and failed
  stage; a failure after the first write returns a partial result (exit 1) on
  stdout, not through the stderr error envelope.
- JSON data goes to stdout; diagnostics and errors (other than the exit-1
  partial result above) go to stderr.
- The application implements no telemetry or analytics.

## Contributing

Requires the pinned Bun version in `package.json`.

```sh
bun install --frozen-lockfile
bun run check   # format, lint, typecheck, coverage, build, smoke test
```

The project is licensed under the [MIT License](LICENSE).

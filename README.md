# Asana CLI

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
| macOS (Apple Silicon) | arm64          | `asana-cli-v0.2.0-darwin-arm64.tar.gz`       |
| macOS (Intel)         | x64            | `asana-cli-v0.2.0-darwin-x64.tar.gz`         |
| Linux / WSL2 (x86_64) | x64 (baseline) | `asana-cli-v0.2.0-linux-x64-baseline.tar.gz` |
| Linux / WSL2 (arm64)  | arm64          | `asana-cli-v0.2.0-linux-arm64.tar.gz`        |

```sh
curl -LO https://github.com/danielsitek/asana-cli/releases/download/v0.2.0/asana-cli-v0.2.0-<target>.tar.gz
curl -LO https://github.com/danielsitek/asana-cli/releases/download/v0.2.0/SHA256SUMS

# Linux / WSL2: verify the checksum before installing
grep " asana-cli-v0.2.0-<target>.tar.gz$" SHA256SUMS | sha256sum -c -

# macOS: use the system-provided checksum utility instead
grep " asana-cli-v0.2.0-<target>.tar.gz$" SHA256SUMS | shasum -a 256 -c -

tar -xzf asana-cli-v0.2.0-<target>.tar.gz
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

# List the direct subtasks of a parent task
asana-cli tasks list --parent=1215978111726134

# Move the task in your personal My Tasks board and comment
asana-cli tasks update 1215978111726134 --my-section=@in_review
asana-cli tasks comment 1215978111726134 "Ready for review"

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
```

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

Task IDs accept raw digit-only GIDs and unambiguous Asana task URLs.

`tasks create` requires `--name` and an explicit destination: `--parent` for a
subtask, `--my-section` for a standalone My Tasks task, or `--project` with a
digit-only project GID. A standalone My Tasks task uses the configured
`workspace.gid`. `--parent` may be combined with `--my-section`; `--project`
cannot be combined with either destination flag.

`tasks update --parent=<gid>|null` reparents an existing task: a GID or task
URL moves it under that parent, and literal `null` promotes it to a top-level
task. It is a dedicated single-write operation and cannot be combined with any
other `tasks update` flag; a task cannot be its own parent.

`tasks list` requires exactly one source: `--my-section=@<alias>` for a My
Tasks section, `--section=<gid>` for any section, `--project=<gid>` for a
project, or `--parent=<id>` for a task's direct subtasks. `--parent` accepts a
task GID or URL. `--my-section` accepts only `@alias` and is resolved and
validated against your live My Tasks the same way as
`tasks update --my-section`.
`--assignee=me|<gid>` and `--completed=true|false` (default `false`) filter
client-side, so they work even when `--fields` omits `assignee` or
`completed`. Reads are bounded the same way as `tasks comments`: a default
scan cap of 100 and result cap of 20, `--max=<n>` to raise the scan cap, and
`--all` (which requires `--max`) to remove the result cap. Default fields are
`gid,name,completed,assignee.gid,assignee.name`.

`--notes` and `--notes-file` are mutually exclusive; notes are replaced
explicitly, with no read-modify-write append. `--notes-file=-` and
`tasks comment --file=-` read from stdin.

`--custom-field=(<field-gid>|@<alias>):<value>` is repeatable and writes number
or enum custom fields. Number values use finite integer or dot-decimal syntax.
Enum values resolve enabled options by GID first, then by case-sensitive exact
name; invalid or ambiguous names list the valid options. `null` clears either
type. Field definitions and options are live-validated before writing.

`--json` returns `{ "data": ..., "meta": ... }` as compact, single-line JSON;
`--fields` selects explicit Asana fields.

## Safety and mutation contract

- The CLI is non-interactive; missing required input fails immediately.
- Reads are bounded; complete traversal always requires an explicit maximum
  (`tasks comments --max=<n>` and `tasks list --max=<n>`, with `--all`
  requiring `--max`).
- `tasks comments --latest=<n>` returns only the globally newest `n` comments,
  newest first, and requires an explicit `--max=<scan-cap>`; it is mutually
  exclusive with `--all` and `--offset`. If the cap is reached before the
  source is fully scanned, it fails and returns no data — rerun with a higher
  `--max`.
- `POST` is never retried after an ambiguous timeout, network error, or 5xx —
  this avoids duplicating a task, subtask, or comment.
- Multi-step writes (such as `tasks create` with My Tasks placement) validate
  every input before the first write, then report every completed and failed
  stage; a failure after the first write returns a partial result.
- JSON data goes to stdout; diagnostics and errors go to stderr.
- The application implements no telemetry or analytics.

## Contributing

Requires the pinned Bun version in `package.json`.

```sh
bun install --frozen-lockfile
bun run check   # format, lint, typecheck, coverage, build, smoke test
```

The project is licensed under the [MIT License](LICENSE).

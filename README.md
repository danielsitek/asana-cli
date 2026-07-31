# Asana CLI

Fast, script-friendly CLI for working with Asana from a terminal or autonomous
agent. It favors explicit fields, bounded reads, deterministic JSON, and
honest reporting of partial writes.

> **Status:** 0.1.0 release candidate. The commands below are implemented and
> tested. **v0.1.0 is not yet public** — release assets and the Homebrew
> formula exist only after a maintainer publishes the draft GitHub release.

## Install

### macOS (Homebrew)

Available only after the `v0.1.0` draft release is published:

```sh
brew tap-new --no-git danielsitek/asana-cli-local
formula_dir="$(brew --repository danielsitek/asana-cli-local)/Formula"
curl -L https://github.com/danielsitek/asana-cli/releases/download/v0.1.0/asana-cli.rb \
  -o "$formula_dir/asana-cli.rb"
brew install danielsitek/asana-cli-local/asana-cli
```

The formula is generated per release and points at architecture-specific
archives (`darwin-arm64`, `darwin-x64`) with embedded SHA-256 checksums. The
local tap is necessary because Homebrew 6 no longer installs a standalone
Formula file directly. A dedicated public tap may replace this step later.

### Direct archive (macOS, Linux, WSL2)

Download the archive for your platform from the release assets, verify its
checksum, then install the binary:

| Platform              | Architecture   | Archive                                      |
| --------------------- | -------------- | -------------------------------------------- |
| macOS (Apple Silicon) | arm64          | `asana-cli-v0.1.0-darwin-arm64.tar.gz`       |
| macOS (Intel)         | x64            | `asana-cli-v0.1.0-darwin-x64.tar.gz`         |
| Linux / WSL2 (x86_64) | x64 (baseline) | `asana-cli-v0.1.0-linux-x64-baseline.tar.gz` |
| Linux / WSL2 (arm64)  | arm64          | `asana-cli-v0.1.0-linux-arm64.tar.gz`        |

```sh
curl -LO https://github.com/danielsitek/asana-cli/releases/download/v0.1.0/asana-cli-v0.1.0-<target>.tar.gz
curl -LO https://github.com/danielsitek/asana-cli/releases/download/v0.1.0/SHA256SUMS

# Linux / WSL2: verify the checksum before installing
grep " asana-cli-v0.1.0-<target>.tar.gz$" SHA256SUMS | sha256sum -c -

# macOS: use the system-provided checksum utility instead
grep " asana-cli-v0.1.0-<target>.tar.gz$" SHA256SUMS | shasum -a 256 -c -

tar -xzf asana-cli-v0.1.0-<target>.tar.gz
sudo install -m 0755 asana-cli /usr/local/bin/asana-cli
```

Replace `<target>` with the value from the table above (e.g. `darwin-arm64`).

macOS binaries carry an ad-hoc signature (no Developer ID signing or
notarization yet); Gatekeeper may require an explicit approval on first run.

### Upgrade

Download the newer archive or overwrite the Formula in the local tap. Then
upgrade the Homebrew installation explicitly:

```sh
formula_dir="$(brew --repository danielsitek/asana-cli-local)/Formula"
curl -L https://github.com/danielsitek/asana-cli/releases/download/v0.2.0/asana-cli.rb \
  -o "$formula_dir/asana-cli.rb"
brew upgrade danielsitek/asana-cli-local/asana-cli
```

### Uninstall

```sh
brew uninstall asana-cli                         # Homebrew package
brew untap danielsitek/asana-cli-local           # optional local tap cleanup
sudo rm /usr/local/bin/asana-cli                 # direct archive install
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

Asana documents PATs as long-lived credentials that act with the same access
as the user who created them. There is no separate CLI permission model: the
Asana account must be able to read and edit the relevant tasks, access its My
Tasks list and sections, read its custom-field definitions, and read and
write task comments. See Asana's
[PAT guide](https://developers.asana.com/docs/personal-access-token) and
[authentication guide](https://developers.asana.com/docs/authentication).

Where Asana documents resource scopes, the API operations used correspond to
`users:read`, `tasks:read`, `tasks:write`, `stories:read`, `stories:write`,
`projects:read`, and `custom_fields:read`. These scopes are useful when OAuth
is added later; PAT creation currently relies on the permissions of the
creating user. Read and write scopes do not imply each other.

### Set the token

For one shell invocation:

```sh
ASANA_CLI_TOKEN="your-token" asana-cli whoami
```

For a development shell:

```sh
export ASANA_CLI_TOKEN="your-token"
asana-cli whoami
```

Adding the export to `.zshrc` is possible but stores the token as plaintext.
Prefer a password manager, CI secret store, or another mechanism that injects
the variable only where needed. Never commit the token. If it is exposed,
revoke it in the Asana developer console and create a replacement.

## Configuration

Initialize the shared workspace configuration:

```sh
asana-cli config init --shared --workspace=1201947864389005
```

Then resolve your personal My Tasks list, sections, and custom-field aliases
into the local gitignored configuration:

```sh
asana-cli config init --local --write-gitignore
```

Shared data lives in `.asana-cli.json`. Personal My Tasks data lives in
`.asana-cli.local.json` and must not be committed. For example:

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

Inspect resolved configuration and its winning source:

```sh
asana-cli config get myTasks.userTaskListGid --source
asana-cli config set workspace.gid 1201947864389005 --shared
asana-cli config show --json --sources
asana-cli config resolve my-tasks
```

## Usage

```sh
# Read a task, including its description
asana-cli tasks get 1215978111726134

# Read comments without unrelated system activity
asana-cli tasks comments 1215978111726134

# Replace a description safely from a file
asana-cli tasks update 1215978111726134 --notes-file=task-description.md

# Move the task in your personal My Tasks board and comment
asana-cli tasks update 1215978111726134 --my-section=@in_review
asana-cli tasks comment 1215978111726134 "Ready for review"

# Create a subtask, assign it to yourself, and set a numeric custom field
asana-cli tasks create \
  --parent=1215978111726134 \
  --name="Implement the change" \
  --assignee=me \
  --my-section=@in_progress \
  --custom-field=@hours_estimate:4
```

Task IDs accept raw digit-only GIDs and unambiguous Asana task URLs.

`--notes` and `--notes-file` are mutually exclusive; notes are replaced
explicitly, with no read-modify-write append. `--notes-file=-` and
`tasks comment --file=-` read from stdin.

`--custom-field=(<field-gid>|@<alias>):<value>` is repeatable and currently
writes only number custom fields (finite integers, dot-decimal numbers, or
`null`); the field definition is live-validated before writing.

Use `--json` for the stable `{ "data": ..., "meta": ... }` response and
`--fields` for explicit Asana fields. Both flags, along with `--help`/`-h`
and `--version`/`-v`, may appear before or after a subcommand.

### JSON output and agents

`--json` produces a stable, script-parseable envelope on stdout; diagnostics
and errors always go to stderr, never stdout. This makes every command safe
to pipe or call from an autonomous agent:

```sh
asana-cli tasks get 1215978111726134 --json | jq '.data.notes'
```

## Safety and mutation contract

- The CLI is non-interactive; missing required input fails with exit code 2.
- Notes are replaced explicitly; there is no implicit append.
- Long notes and comments may be read from a file or stdin.
- Reads are bounded; complete traversal always requires an explicit maximum
  (`tasks comments --max=<n>`, with `--all` requiring `--max`).
- `GET` and `PUT` retry network errors, `429`, `502`, `503`, and `504`. `POST`
  retries only an explicit `429` response and is never retried
  after an ambiguous timeout, network error, or 5xx — this avoids duplicating
  a task, subtask, or comment.
- Multi-step writes (such as `tasks create` with My Tasks placement) validate
  every input before the first write, then report every completed and failed
  stage; a failure after the first write returns a partial result.
- JSON data goes to stdout; diagnostics and errors go to stderr.
- The application implements no telemetry or analytics.

### Exit codes

| Code | Meaning                                      |
| ---- | -------------------------------------------- |
| 0    | success                                      |
| 1    | partial write or partial multi-stage failure |
| 2    | invalid usage or configuration               |
| 3    | authentication or authorization failure      |
| 4    | Asana API, not-found, or network error       |
| 5    | rate-limit or retry exhaustion               |
| 6    | unexpected internal CLI error                |

## Contributing

Requires the pinned Bun version in `package.json`.

```sh
bun install --frozen-lockfile
bun run check   # format check, lint, typecheck, coverage, build, smoke test
```

Individual checks are also available: `bun run format:check`, `bun run lint`,
`bun run typecheck`, `bun run test:coverage`, `bun run build`.

Releases are cut from tags and produce a **draft** GitHub release with built
archives, checksums, and a generated Homebrew formula; a maintainer must
manually review and publish the draft before it becomes public.

## Implementation

The stack is TypeScript and Bun. Bun compiles standalone executables for
release, so users do not need Bun or Node.js installed. See
[technology and release decisions](docs/tech-stack.md) for the architecture
and release rationale.

The project is licensed under the MIT License.

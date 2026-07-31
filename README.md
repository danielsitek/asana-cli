# Asana CLI

Fast, script-friendly CLI for working with Asana from a terminal or autonomous
agent. It favors explicit fields, bounded reads, deterministic JSON, and
honest reporting of partial writes.

> **Status:** design and pre-implementation. The commands below define v0.1;
> there is no installable release yet.

## v0.1 workflows

```sh
# Read a task, including its description
asana-cli tasks get 1215978111726134

# Read comments without unrelated system activity
asana-cli tasks comments 1215978111726134

# Replace a description safely from a file
asana-cli tasks update 1215978111726134 \
  --notes-file=task-description.md

# Move the task in your personal My Tasks board and comment
asana-cli tasks update 1215978111726134 \
  --my-section=@in_review

asana-cli tasks comment 1215978111726134 "Ready for review"

# Create a subtask, assign it to yourself, and set a numeric custom field
asana-cli tasks create \
  --parent=1215978111726134 \
  --name="Implement the change" \
  --assignee=me \
  --my-section=@in_progress \
  --custom-field=@hours_estimate:4
```

Use `--json` for the stable `{ "data": ..., "meta": ... }` response and
`--fields` for explicit Asana fields.

## Authentication

v0.1 reads the token only from `ASANA_CLI_TOKEN`. It never accepts a token as a
CLI argument, writes it to a shell profile, or loads it automatically from a
`.env` file.

### Create a personal access token

1. Open the [Asana developer console](https://app.asana.com/0/my-apps), or in
   Asana open **Settings → Apps → View developer console**.
2. Open **Personal access tokens**, create a token, and give it a recognizable
   description such as `asana-cli`.
3. Copy the token when Asana displays it and store it as a secret.

Asana documents PATs as long-lived credentials that act with the same access
as the user who created them. There is no separate v0.1 CLI permission model:
the Asana account must be able to read and edit the relevant tasks, access its
My Tasks list and sections, read its custom-field definitions, and read and
write task comments. See Asana's
[PAT guide](https://developers.asana.com/docs/personal-access-token) and
[authentication guide](https://developers.asana.com/docs/authentication).

Where Asana documents resource scopes, the API operations used by v0.1
correspond to `users:read`, `tasks:read`, `tasks:write`, `stories:read`,
`stories:write`, `projects:read`, and `custom_fields:read`. These scopes are
useful when OAuth is added later; PAT creation currently relies on the
permissions of the creating user. Read and write scopes do not imply each
other.

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
asana-cli config init --shared \
  --workspace=1201947864389005
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

## Safety contract

- v0.1 is non-interactive.
- Notes are replaced explicitly; there is no implicit append.
- Long notes and comments may be read from a file or stdin.
- Reads are bounded; complete traversal always requires an explicit maximum.
- POST requests are not retried after ambiguous failures that could duplicate
  a task or comment.
- Multi-step writes report every completed and failed stage.
- JSON data goes to stdout; diagnostics and errors go to stderr.
- The application implements no telemetry or analytics.

Exit codes: `0` success, `1` partial write, `2` invalid usage or config, `3`
authentication or authorization failure, `4` Asana API error or not found, `5`
rate-limit or retry exhaustion, and `6` unexpected internal CLI error.

## Implementation

The selected stack is TypeScript and Bun. Bun is used for development, tests,
and standalone executables; users will not need Bun or Node.js installed.
Initial distribution targets macOS through Homebrew and Linux/WSL2 through
GitHub release archives.

See:

- [v0.1 scope](docs/v0.1.md)
- [technology stack](docs/tech-stack.md)
- [target product specification](docs/asana-cli.md)

The project is licensed under the MIT License.

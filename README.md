# Asana CLI

Fast, script-friendly CLI for working with Asana tasks without unnecessary API
output. It is designed for both people and automation: commands are
non-interactive by default, return compact output, and support JSON when needed.

## Quick start

Authenticate with a personal access token. The token is read from
`ASANA_CLI_TOKEN`, or from stdin when that variable is unset, and stored in the
OS keychain.

```sh
echo "$TOKEN" | asana-cli login
asana-cli whoami
```

Initialize project configuration:

```sh
asana-cli config init --shared \
  --workspace=1201947864389005 \
  --project=1215855197447915 \
  --no-input

asana-cli config doctor
```

The workspace is read from config for all regular commands, so it does not need
to be passed repeatedly. Shared project settings are stored in
`.asana-cli.json`; personal My Tasks settings belong in the gitignored
`.asana-cli.local.json`.

When a project is supplied, `config init` imports its sections as aliases. For
example, a section named `In Progress` becomes `@in_progress`.

## Common commands

```sh
# Find open tasks
asana-cli tasks search --project=1215855197447915 --assignee=me --completed=false

# Read a task (a supported Asana task URL works too)
asana-cli tasks 1215978111726134

# Create and place a task in a configured project section
asana-cli tasks create \
  --name="Prepare release notes" \
  --assignee=me \
  --due-on=2026-08-15 \
  --section=@in_progress

# Update a task
asana-cli tasks 1215978111726134 update \
  --completed=true \
  --section=@done

# Add a comment and read activity
asana-cli tasks 1215978111726134 comment "Ready for review"
asana-cli tasks 1215978111726134 stories

# List projects and sections
asana-cli projects
asana-cli sections list --project=1215855197447915
```

Use `--json` for a stable `{ "data": ..., "meta": ... }` response:

```sh
asana-cli tasks search --assignee=me --completed=false --json
```

Use `--fields` to request additional Asana fields:

```sh
asana-cli tasks 1215978111726134 --fields=name,notes,due_on,assignee.email
```

## Configuration

Configuration is merged from CLI flags, selected environment variables, local
project config, shared project config, and global user config. Inspect the
effective values or update individual keys with:

```sh
asana-cli config show --sources
asana-cli config get workspace.gid --source
asana-cli config set project.gid 1215855197447915 --shared
```

Named project sections can be referenced as `@todo`, `@in_progress`, or
`@done`. Personal My Tasks sections use separate local settings and can be
referenced with `--my-section=@in_review`.

## Safe automation

- Search requires at least one filter and never dumps a whole workspace by
  default.
- Full pagination requires both `--all` and an explicit `--max=<n>` limit.
- Destructive task and section deletion requires `--yes`.
- Bulk commands report each item separately and return a non-zero exit code when
  any item fails.
- Run any command with `--help` to see its available options.

Exit codes: `0` success, `1` partial bulk failure, `2` invalid usage or config,
`3` authentication or authorization failure, `4` Asana API error or not found,
and `5` rate-limit or retry exhaustion.

## Full reference

See [docs/asana-cli.md](docs/asana-cli.md) for all commands, configuration
rules, output fields, API behavior, and reliability details.

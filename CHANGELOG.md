# Changelog

All notable changes to this project are documented in this file. This project
follows [Semantic Versioning](https://semver.org/).

## 0.2.0

- Add generated command completion for Bash, Zsh, and Fish, including nested
  commands, supported global options, enum values, and file paths.
- Install shell completions automatically through the Homebrew formula and
  document setup for direct archive installations.
- Include an installable AI agent skill with a complete project initialization
  workflow that configures the personal default assignee as `me`.

## 0.1.0

Initial public release. Implements the My Tasks-first workflow:

- Identity and discovery commands: `whoami`, `workspaces list`, and
  `config init|get|set|show|resolve my-tasks`.
- Read, list, create, update, reparent, and comment on tasks. Creation supports
  standalone tasks and subtasks; listing supports My Tasks sections, project
  sections, and projects.
- My Tasks section aliases, personal default assignees, and numeric or enum
  custom-field values.
- Bounded comment traversal and exact newest-first reads with
  `tasks comments --latest`.
- Global `--json`, `--fields`, `--help`, and `--version` flags with compact,
  single-line JSON output.
- Authentication via `ASANA_CLI_TOKEN` only; no login, keychain, or `.env`
  support.
- Bounded reads, explicit note replacement, method-aware retries, and
  multi-stage partial-write reporting.
- Standard exit codes `0`–`6` (success, partial write, invalid usage, auth
  failure, API error, retry exhaustion, internal error).
- Standalone Bun-compiled executables for `darwin-arm64`, `darwin-x64`,
  `linux-x64-baseline`, and `linux-arm64` with SHA-256 checksums.
- Homebrew tap installation for macOS.
- Manually gated draft release workflow; no automatic publication.

# Changelog

All notable changes to this project are documented in this file. This project
follows [Semantic Versioning](https://semver.org/).

## 0.1.0

Initial release candidate. Implements the My Tasks-first vertical slice:

- `whoami`, `config init|get|set|show|resolve my-tasks`.
- `tasks get`, `tasks update`, `tasks create` (subtasks), `tasks comments`,
  `tasks comment`.
- Global `--json`, `--fields`, `--help`, and `--version` flags.
- Authentication via `ASANA_CLI_TOKEN` only; no login, keychain, or `.env`
  support.
- Bounded reads, explicit note replacement, method-aware retries, and
  multi-stage partial-write reporting.
- Standard exit codes `0`–`6` (success, partial write, invalid usage, auth
  failure, API error, retry exhaustion, internal error).
- Standalone Bun-compiled executables for `darwin-arm64`, `darwin-x64`,
  `linux-x64-baseline`, and `linux-arm64` with SHA-256 checksums.
- Generated Homebrew formula for macOS installs.
- Manually gated draft release workflow; no automatic publication.

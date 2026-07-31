# Technology stack

This document records the technical decisions for the first implementation of
Asana CLI. Product behavior belongs in `asana-cli.md`; the exact v0.1 boundary
belongs in `v0.1.md`.

## Priorities

In order:

1. Ship a reliable, maintainable tool quickly.
2. Keep the installed CLI self-contained.
3. Make every workflow usable by humans and autonomous agents.
4. Minimize dependencies without reimplementing high-risk infrastructure.
5. Keep output and failure behavior deterministic.

Learning a new systems language is not a project goal. Native Windows support,
Node.js compatibility, and npm distribution are not v0.1 goals.

## Runtime and language

- TypeScript, strict mode.
- Bun is the package manager, runtime, test runner, bundler, and executable
  compiler.
- The project is Bun-first. Node.js runtime compatibility is not guaranteed.
- ESM only: `"type": "module"`, no CommonJS.
- Internal imports use explicit `.ts` extensions.
- Use named exports. An `index.ts` file is allowed only as the small public
  boundary of a deep module, not as an application-wide barrel.
- Pin the exact Bun version in `package.json` and use the same version in CI.
- Commit `bun.lock`; CI installs with `bun install --frozen-lockfile`.
- Commit a development `bunfig.toml` with `env = false` and
  `telemetry = false`. This prevents the outer `bun run` process from loading
  `.env` before a package script starts and disables Bun development telemetry.

Recommended TypeScript settings include:

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "types": ["bun"],
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

`@types/bun` supplies Bun and Node-compatible API types. Do not add
`@types/node` independently unless a concrete missing type requires it and the
selected version is verified to be compatible.

## Dependencies

Initial runtime dependencies:

- `commander` — command tree, arguments, options, and generated help.
- `zod` — validation of CLI values, configuration, bulk input, and API
  boundaries.

Initial development dependencies:

- `typescript`
- `@types/bun`
- `eslint`
- `@eslint/js`
- `typescript-eslint`
- `eslint-config-prettier`
- `prettier`

Do not add packages for HTTP, retries, concurrency, tables, colors, environment
files, keychain access, logging, testing, mocking, Result types, git hooks, or
releases. A new dependency needs a concrete justification showing that it
removes a meaningful amount of risky custom code.

## Architecture

Use functional modules by default and deep modules where encapsulation makes
the API materially easier to use.

```text
src/
  main.ts
  cli/          Commander tree and argv-to-input parsing
  commands/     application use cases grouped by resource
  asana/        REST client and endpoint adapters
  auth/         token resolution
  config/       schemas, layers, merge, sources, and writes
  output/       JSON, detail, table, and error rendering
  shared/       identifiers, Result, retry, pagination, and concurrency
  utils/        helper utility functions, one utility function per file
```

Use classes only for components with meaningful state, such as an HTTP client
or rate limiter. Do not use a dependency-injection framework or global service
locator. Command handlers receive an explicit context and return a result;
only the entry point writes to process streams and selects the exit code.

Expected failures use a local discriminated union:

```ts
type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

Exceptions are reserved for programmer errors and truly unexpected failures.
An unexpected exception is hidden behind `internal_error`; its stack is shown
only with debug output.

## CLI parsing

Commander models conventional action-first commands:

```text
asana-cli tasks get <id>
asana-cli tasks update <id>
asana-cli tasks comment <id>
```

Do not implement the earlier dynamic `tasks <id> update` form. It prevents a
clean static command tree and weakens help and option validation.

`--json`, `--debug`, `--fields`, help, and version may appear before or after a
subcommand. A capability-validation layer rejects a globally parsed flag on a
command that does not support it. Pagination options live only on list
commands.

The CLI is non-interactive in v0.1. Missing input fails with exit code 2.
Do not add a prompt library. Commands never modify shell profiles.

## Asana API client

Use a small client over Bun `fetch`, not the Asana SDK. The client owns:

- base URL and authorization headers;
- explicit `opt_fields`;
- JSON envelope validation;
- pagination;
- request timeouts;
- conservative retry behavior;
- concurrency control;
- Asana error conversion;
- request IDs and debug timing.

Validate the common API envelope and every field used for CLI decisions.
Preserve additional resource fields as JSON so arbitrary `--fields` values are
not discarded. Do not generate a complete client from Asana OpenAPI.

Default network settings:

```json
{
  "network": {
    "concurrency": 4,
    "maxRetries": 3,
    "requestTimeoutMs": 30000
  }
}
```

Retry policy:

- `GET`: retry network failures, 429, 502, 503, and 504.
- `PUT` and `DELETE`: same policy because the intended operations are
  idempotent.
- `POST`: retry only an explicit 429 response.
- Never retry a POST after a timeout, ambiguous network failure, or 5xx; doing
  so could duplicate a task, subtask, or comment.
- Respect `Retry-After`; otherwise use exponential backoff with jitter.
- Implement the semaphore, backoff, and jitter locally.

## Authentication and secrets

v0.1 reads only `ASANA_CLI_TOKEN`. It does not implement `login`, `logout`, OS
keychain storage, `.env` loading, or writes to `.zshrc` and similar files.

The repository `bunfig.toml` disables `.env` loading for development commands.
The release executable must independently disable Bun's automatic loading of
`.env` and `bunfig.toml`. Never accept a token as a CLI argument. Never log
authorization headers, request bodies, response bodies, or token-shaped
configuration.

OS keychain support remains a later feature.

## Configuration

Configuration is strict JSON validated with Zod. Do not support JSONC, YAML, or
TOML. Configuration is normally changed through CLI commands.

Find the nearest git root by walking parent directories for a `.git` directory
or worktree `.git` file. Do not execute the Git CLI. Outside a git repository,
skip project configuration and use global configuration only.

Keep the documented precedence and deep-merge behavior. Writes use a temporary
file plus atomic rename. Shared config may not contain personal My Tasks data.
Local config initialization requires the file to be gitignored; modifying
`.gitignore` requires explicit `--write-gitignore`.

Configuration schema versioning is intentionally deferred while the tool has no
external users with persistent configs.

## Output and diagnostics

- JSON output uses the stable `{ "data": ..., "meta": ... }` envelope.
- Expected errors use `{ "error": ... }` on stderr and write nothing to stdout
  when no partial write occurred.
- Collections use a minimal borderless table.
- Single resources use a key/value detail view with multiline blocks.
- v0.1 has no colors.
- Use Bun `stringWidth`, `sliceAnsi`, and `wrapAnsi`; do not add terminal-width
  packages.
- Preserve API order unless a command explicitly documents sorting.
- `null` renders as `—` in human output.

The application implements no telemetry or analytics. Bun development
telemetry is disabled in `bunfig.toml`. `--debug` and `ASANA_CLI_DEBUG=1` write
only to stderr and may include method, endpoint path, status, elapsed time,
retry attempt, and Asana request ID. Redact sensitive query values and never
include bodies.

Exit codes:

```text
0 success
1 partial write or partial multi-stage failure
2 invalid usage or configuration
3 authentication or authorization failure
4 Asana API error or not found before any successful write
5 rate-limit or retry exhaustion before any successful write
6 unexpected internal CLI error
```

Exit code 1 takes precedence after any successful write.

## Testing

Use `bun:test`; do not add Vitest, Jest, MSW, or another mock framework.

- Unit tests live next to source as `*.test.ts`.
- Process and integration tests live under `test/`.
- HTTP integration tests use a local fake Asana server built with `Bun.serve`.
- Golden fixtures cover human and JSON output.
- Process tests assert stdout, stderr, and exit code independently.
- Fault tests cover auth errors, 429, retryable 5xx, ambiguous POST failures,
  truncation, and partial multi-stage writes.
- Live Asana tests are optional and never run in normal CI.
- CI enforces at least 80% overall coverage.
- Identifier parsing, configuration precedence, exit-code mapping, retry
  decisions, and mutation stages require explicit branch scenarios regardless
  of the global percentage.

Do not add repository-managed git hooks. `bun run check` and CI are
authoritative.

## Build and distribution

Development runs source directly with `bun run src/main.ts`; the committed
`bunfig.toml` prevents automatic `.env` loading by the outer Bun process.
Release builds use Bun `--compile`, minification, and an embedded sourcemap,
without bytecode. Inject the CLI version from `package.json` as a build-time
constant. Never inject environment secrets.

Initial release targets:

```text
darwin-arm64
darwin-x64
linux-x64-baseline
linux-arm64
```

Primary distribution:

- GitHub Releases with archives and SHA-256 checksums;
- Homebrew for macOS;
- direct archive download for Linux and WSL2.

npm distribution and native Windows are deferred. macOS v0.1 executables use
an ad-hoc signature and Bun JIT entitlements. Developer ID signing and
notarization wait until an Apple Developer account is available.

CI is present from the initial scaffold and runs frozen install, formatting
check, lint, typecheck, tests, coverage, and build. A tag-driven release
workflow is added before v0.1. Releases use Semantic Versioning, conventional
commit messages, a manually maintained changelog, and no release framework.
The project license is MIT.

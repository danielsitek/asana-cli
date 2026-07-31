# Architecture and release decisions

Durable rationale for consequential, non-obvious trade-offs. Product
behavior and the CLI contract live in `README.md`; implementation detail
lives in code and tests.

## Runtime and language

TypeScript (strict) on a pinned Bun version, committed in `package.json` and
used identically in CI. Bun is the package manager, test runner, bundler, and
`--compile` executable producer, so the shipped CLI needs no separate Bun or
Node.js install. ESM only, no CommonJS. Node.js runtime compatibility is not
guaranteed; Node, npm distribution, and native Windows support are not goals.

## Dependencies

Only `commander` (command tree, options, help) and `zod` (validation of CLI
input, configuration, and API boundaries) are runtime dependencies. HTTP,
retries, concurrency, tables, colors, env-file loading, keychain access,
logging, and release tooling are implemented locally rather than pulled in,
to keep the compiled binary small and the dependency surface auditable. A new
dependency needs a concrete justification that it removes meaningful risky
custom code.

## Module shape

Functional deep modules organized by owned behavior (`tasks/`, `config/`,
`asana/`, `auth/`, `output/`), not by one-to-one command or layer wrappers.
`src/utils/` is reserved for reusable, context-free leaf helpers — one
function per file — so domain and workflow logic keeps its policy (retries,
pagination, validation sequencing) local to the module that owns it instead
of leaking into a shared-but-coupled utility layer.

## Authentication

The token is read only from `ASANA_CLI_TOKEN`. There is no `.env` loading and
no `bunfig.toml` autoload of environment files: the committed `bunfig.toml`
disables `.env` loading during development, and the compiled release
executable independently disables Bun's automatic `.env`/`bunfig.toml`
loading. This removes an entire class of accidental-secret-leak and
environment-shadowing bugs, at the cost of requiring an explicit `export` or
inline invocation.

## Network reliability

Retries are method-aware rather than blanket: `GET` and `PUT` retry network
failures and `429`/`502`/`503`/`504` because the implemented operations are
idempotent; `POST` retries only an explicit `429` and is never retried after a
timeout, ambiguous network error, or 5xx, because retrying an already-sent,
unacknowledged `POST` risks duplicating a task, subtask, or comment.
`Retry-After` takes precedence over local exponential backoff with jitter.

## Build targets and macOS signing

Release executables target `darwin-arm64`, `darwin-x64`,
`linux-x64-baseline`, and `linux-arm64` — the practical intersection of
Bun's compile targets and this project's declared platforms (macOS,
Linux, WSL2). macOS binaries use an ad-hoc signature; Developer ID signing
and notarization are deferred until an Apple Developer account exists, so
first-run Gatekeeper approval is a known, accepted rough edge rather than an
oversight.

## Deterministic packaging

`package-release.ts` builds archives with fixed tar metadata
(`--sort=name`, `--mtime=@0`, `--owner=0`, `--group=0`, normalized mode) and
`gzip -n`, so identical input binaries produce byte-identical archives and
checksums. This lets `generate-homebrew-formula.ts` embed a checksum per
architecture directly from the same run's manifest.

## Draft release and human-in-the-loop publication

The tag-driven release workflow always creates or updates a **draft** GitHub
release with built archives, checksums, and the generated Homebrew formula —
it never publishes automatically. A maintainer must review and publish the
draft. This keeps a broken or premature build from becoming a public,
un-retractable release, at the cost of a manual step per release.

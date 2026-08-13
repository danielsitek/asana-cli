# Learnings

> Persistent lessons learned from user corrections.
> Every AI agent reads this file at the start of each task and applies all rules here.
> New rules are appended here whenever the user corrects a mistake.

Format: one rule per entry, imperative mood, with a short reason.

- Include `src/utils/` only for reusable, context-free leaf helpers and keep one utility function per file; keep domain and workflow behavior inside its owning deep module to preserve locality.
- Treat implementation code and behavior-focused tests as the durable source of truth; keep temporary specs only while planning, and retain Markdown after implementation only for public contracts, ADRs, domain vocabulary, or navigation that code cannot express.
- For Claude Code frontmatter/permission syntax (e.g. `allowed-tools`, `Bash(...)` patterns), verify against official docs (code.claude.com/docs) before flagging as a bug — `Bash(cmd *)` and `Bash(cmd:*)` are documented as equivalent, and space- or comma-separated tool lists are both valid; don't infer correctness from convention seen in unrelated skill files.
- In this README, document exporting `ASANA_CLI_TOKEN` from `~/.zshrc` as the preferred persistent-token setup, with a one-line code sample, and no surrounding caveats — developers already know the plaintext tradeoff, so don't explain it.
- Split implementation and user or agent documentation into separate atomic commits when they can be reviewed independently; keep behavior tests with the implementation they verify.
- Never hand-edit `homebrew-tap/Formula/asana-cli.rb`; regenerate it with `bun run formula:generate --checksums <SHA256SUMS> --output <path> --version X.Y.Z` from the published release's checksums, per `docs/release-process.md` — the script is the single source of truth for formula shape and avoids transcription drift.
- After publishing a GitHub release with `draft=false` and `make_latest=true` in one PATCH, verify with `gh api repos/OWNER/REPO/releases/latest --jq .tag_name` before reporting the release done — GitHub can silently skip the `latest` update on that combined call with no error, so the flag alone isn't proof it took effect.

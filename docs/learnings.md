# Learnings

> Persistent lessons learned from user corrections.
> Every AI agent reads this file at the start of each task and applies all rules here.
> New rules are appended here whenever the user corrects a mistake.

Format: one rule per entry, imperative mood, with a short reason.

- Include `src/utils/` only for reusable, context-free leaf helpers and keep one utility function per file; keep domain and workflow behavior inside its owning deep module to preserve locality.
- Treat implementation code and behavior-focused tests as the durable source of truth; keep temporary specs only while planning, and retain Markdown after implementation only for public contracts, ADRs, domain vocabulary, or navigation that code cannot express.
- For Claude Code frontmatter/permission syntax (e.g. `allowed-tools`, `Bash(...)` patterns), verify against official docs (code.claude.com/docs) before flagging as a bug — `Bash(cmd *)` and `Bash(cmd:*)` are documented as equivalent, and space- or comma-separated tool lists are both valid; don't infer correctness from convention seen in unrelated skill files.

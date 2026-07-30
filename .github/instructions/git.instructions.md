---
description: Git workflow, commit messages, and branching strategy
applyTo: "**/*"
---

# Git Instructions

- Always use English for commit messages.
- Never include "Generated with Claude" or "Co-authored-by: Copilot" (or similar) in commit messages.
  - Examples of what not to include:
    - "Generated with Claude"
    - "Co-authored-by: Copilot <copilot@github.com>"
    - "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"

## Branching and Flow

- Main branch is `main`.
- Never commit directly to `main`; always use a feature branch.
- Always merge with `--no-ff` to create an explicit merge commit.
- Branch naming: `<branch-type>/<initials>-<short-description>`.
- Resolve `<initials>` from the session context field `git_user_initials`:
  - If `initials_source=explicit` — use the value directly, no further check needed.
  - If `initials_source=generated` or the session context is unavailable — **stop
    immediately**. Do not create the branch or commit. Instruct the user to set it first:
    ```bash
    git config --global user.initials <your-initials>
    ```

Branch types: `feature`, `hotfix`, `release`.

> **Note:** Branch types (`feature`, `hotfix`, `release`) are **not** the same as commit types (`feat`, `fix`, `chore`, …). Do not mix them up — a branch named `chore/…` or a commit `feature: …` is wrong.

Examples:

```
feature/dsi-auth-flow
hotfix/dsi-login-timeout
release/1.0.0
```

Start work:

```bash
git checkout main
git fetch --verbose
git pull origin main
git checkout -b <branch-type>/<initials>-<short-description>
```

## Commit Messages

Format:

```
<type>: <description>
```

Types: `feat`, `fix`, `refactor`, `docs`, `style`, `test`, `chore`.

Rules:

- Max 72 characters on the first line.
- Lowercase, no period, imperative mood.

Examples:

```
feat: add modal components
fix: update line references in localization files
style: unify string quotes in CompanyListItem
```

## Before Committing

- Review changes: `git status`, `git diff`.
- Run checks: `npm run format --if-present`, `npm run lint --if-present`, `npx tsc --noEmit` and `npm run build --if-present`.

## Good Practices

- Keep commits atomic (one logical change).
- Commit frequently after each completed step.
- If you need to fix a commit message before push:

```bash
git commit --amend -m "fix: correct commit message"
```

## Undo (Use Carefully)

```bash
git reset HEAD <file>      # Unstage
git checkout -- <file>     # Discard local changes
git reset --soft HEAD~1    # Undo last commit, keep changes
```

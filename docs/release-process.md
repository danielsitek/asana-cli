# Release process

Spans two repos: `asana-cli` (this repo) and `danielsitek/homebrew-tap`
(local checkout `~/Sites/homebrew-tap`).

## 1. asana-cli

1. `git checkout main && git fetch --verbose && git pull origin main`, then
   `git checkout -b release/X.Y.Z`.
2. Bump the version in all four spots (`grep -rn "OLD.VERSION"` to find them
   all): `package.json`, `src/main.ts` fallback, `src/cli/index.ts` fallback
   (two occurrences), README install examples/table. Update matching test
   expectations (`scripts/build.test.ts`, `scripts/verify-release-tag.test.ts`,
   `src/cli/index.test.ts`).
3. Add a `CHANGELOG.md` entry above the previous version, grouped from
   `git log vPREV..HEAD --oneline --no-merges`.
4. `bun run check` — must pass before committing.
5. Commit `chore: release X.Y.Z`, push, `gh pr create`.
6. Wait for CI, then verify before merging:
   `gh pr checks <n>` (all green) and
   `gh pr view <n> --json mergeable,mergeStateStatus` (`MERGEABLE`/`CLEAN`).
7. `gh pr merge <n> --merge` (explicit merge commit, per
   `.github/instructions/git.instructions.md`).
8. Tag the merge commit and push:
   ```sh
   git checkout main && git pull origin main
   git branch -d release/X.Y.Z
   git push origin --delete release/X.Y.Z
   git tag -a vX.Y.Z -m "vX.Y.Z" <merge-commit-sha>
   git push origin vX.Y.Z
   ```
   This triggers `.github/workflows/release.yml`: builds all 4 targets,
   packages archives + `asana-cli.rb` (via `formula:generate`), verifies a
   Homebrew install, and opens/updates a **draft** GitHub release.
9. Find the draft's numeric release ID — its `html_url` shows a misleading
   `.../releases/tag/untagged-<hash>` (a GitHub quirk for unpublished
   releases) even though `tag_name` is already correct, so `gh release view
   vX.Y.Z` won't find it yet:
   ```sh
   gh api repos/danielsitek/asana-cli/releases --jq \
     '.[] | select(.tag_name=="vX.Y.Z") | .id'
   ```
10. Write release notes matching prior releases' format (see e.g. `v0.2.0`):
    `## What's new` (bullets from the CHANGELOG entry), `## Install` (brew +
    skill install commands), and a `**Full changelog:**` compare link
    (`.../compare/vPREV...vX.Y.Z`). Then publish and mark latest in one call:
    ```sh
    gh api repos/danielsitek/asana-cli/releases/<id> -X PATCH \
      -f body="<release notes>" -f draft=false -f make_latest=true
    ```

## 2. homebrew-tap

The formula must never be hand-edited — always regenerate it from the
published release's checksums, using the same generator CI uses. No CI, no
reviewer, and a single generated file in this repo, so commit straight to
`main` and push — no branch or PR:

```sh
cd ~/Sites/homebrew-tap
git checkout main && git pull origin main

gh release download vX.Y.Z -R danielsitek/asana-cli -p SHA256SUMS -D /tmp --clobber
cd ~/Sites/asana-cli
bun run formula:generate --checksums /tmp/SHA256SUMS \
  --output ~/Sites/homebrew-tap/Formula/asana-cli.rb --version X.Y.Z
cd ~/Sites/homebrew-tap
ruby -c Formula/asana-cli.rb
git diff  # eyeball the change — this is the review step, in place of a PR

git add Formula/asana-cli.rb
git commit -m "feat: update asana-cli to X.Y.Z"
git push origin main
```

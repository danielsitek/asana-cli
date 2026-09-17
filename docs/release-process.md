# Release process

Spans two repos: `asana-cli` (this repo) and `danielsitek/homebrew-tap`.

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
   packages archives and `SHA256SUMS`, and opens/updates a **draft** GitHub
   release. Homebrew installation is tested by the tap after publication.
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
    GitHub's API can silently skip the `latest` update when `draft:false` and
    `make_latest:true` are set in the same call on a still-draft release, with
    no error — verify it stuck:
    ```sh
    gh api repos/danielsitek/asana-cli/releases/latest --jq .tag_name
    ```
    If it doesn't match `vX.Y.Z`, retry with a second, separate PATCH
    containing only `-f make_latest=true`.

## 2. homebrew-tap

Publishing a stable release triggers `.github/workflows/notify-homebrew-tap.yml`,
which sends an `upstream_release` repository dispatch containing the source
repository and tag. The tap downloads the published release, regenerates the
formula from `SHA256SUMS`, tests installation on macOS ARM and Intel, and only
then commits the newer formula. Drafts and prereleases do not trigger this
notification. The tap's daily scheduled run catches missed dispatches.

The notifier requires the `HOMEBREW_TAP_DISPATCH_TOKEN` repository secret in
`asana-cli`: a fine-grained PAT restricted to `danielsitek/homebrew-tap` with
`Contents: read and write` permission. The ordinary `GITHUB_TOKEN` cannot
dispatch to another repository. A missing or expired token fails the notifier
workflow visibly; rotate it by replacing this secret, without putting the
token in source code, release assets, or logs.

After publishing, check the notifier and tap workflows:

```sh
gh run list -R danielsitek/asana-cli --workflow notify-homebrew-tap.yml --limit 5
gh run list -R danielsitek/homebrew-tap --workflow update-formulas.yml --limit 5
```

A successful notifier means GitHub accepted the dispatch, not that the tap
update finished. Confirm the tap workflow succeeded and
`homebrew-tap/Formula/asana-cli.rb` points to `vX.Y.Z`. For a missed or failed
dispatch, fix the credential or tap failure, then retry without editing the
formula by hand:

```sh
gh workflow run update-formulas.yml -R danielsitek/homebrew-tap \
  -f repository=danielsitek/asana-cli -f tag=vX.Y.Z
```

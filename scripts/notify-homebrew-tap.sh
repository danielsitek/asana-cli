#!/usr/bin/env bash
set -euo pipefail

if [ -z "${GH_TOKEN:-}" ]; then
  echo "HOMEBREW_TAP_DISPATCH_TOKEN is not configured" >&2
  exit 1
fi
if [ "${SOURCE_REPOSITORY:-}" != "danielsitek/asana-cli" ]; then
  echo "Unexpected source repository: ${SOURCE_REPOSITORY:-}" >&2
  exit 1
fi
if [[ ! "${RELEASE_TAG:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Unexpected release tag: ${RELEASE_TAG:-}" >&2
  exit 1
fi

jq -nc --arg repository "$SOURCE_REPOSITORY" --arg tag "$RELEASE_TAG" \
  '{event_type:"upstream_release",client_payload:{repository:$repository,tag:$tag}}' |
  gh api --method POST repos/danielsitek/homebrew-tap/dispatches --input -

#!/usr/bin/env bash

set -euo pipefail

readonly repository="danielsitek/asana-cli"
readonly api_url="https://api.github.com/repos/${repository}/releases/latest"
readonly -a curl_retry_options=(--retry 3 --retry-delay 1 --retry-all-errors)
temporary_directory=""

cleanup() {
  if [[ -n "$temporary_directory" ]]; then
    rm -rf -- "$temporary_directory"
  fi
}

fail() {
  printf 'asana-cli install: %s\n' "$1" >&2
  exit 1
}

detect_target() {
  local os architecture
  os="$(uname -s)"
  architecture="$(uname -m)"

  case "${os}:${architecture}" in
    Darwin:arm64) printf 'darwin-arm64\n' ;;
    Darwin:x86_64) printf 'darwin-x64\n' ;;
    Linux:x86_64) printf 'linux-x64-baseline\n' ;;
    Linux:aarch64 | Linux:arm64) printf 'linux-arm64\n' ;;
    *) fail "unsupported platform ${os}/${architecture}" ;;
  esac
}

resolve_latest_tag() {
  local response tag
  local -a headers=(
    --header "Accept: application/vnd.github+json"
    --header "X-GitHub-Api-Version: 2022-11-28"
  )

  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    headers+=(--header "Authorization: Bearer ${GITHUB_TOKEN}")
  fi

  response="$(curl -fsSL "${curl_retry_options[@]}" "${headers[@]}" "$api_url")"
  if [[ "$response" =~ \"tag_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    tag="${BASH_REMATCH[1]}"
  else
    fail "latest release response has no tag_name"
  fi

  [[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
    fail "latest release tag is not a stable version"
  printf '%s\n' "$tag"
}

verify_checksum() {
  local directory archive_name checksum_file matching_checksum
  directory="$1"
  archive_name="$2"
  checksum_file="$3"
  matching_checksum="${directory}/ASSET_SHA256"

  awk -v archive="$archive_name" \
    '$1 ~ /^[0-9a-fA-F]{64}$/ && $2 == archive && NF == 2 { print }' \
    "$checksum_file" > "$matching_checksum"
  [[ -s "$matching_checksum" ]] || fail "release checksum is missing for ${archive_name}"
  [[ "$(wc -l < "$matching_checksum" | tr -d '[:space:]')" == "1" ]] ||
    fail "release checksum is ambiguous for ${archive_name}"

  if [[ "$(uname -s)" == "Darwin" ]]; then
    (cd "$directory" && shasum -a 256 -c "$(basename "$matching_checksum")")
  else
    (cd "$directory" && sha256sum -c "$(basename "$matching_checksum")")
  fi
}

choose_install_directory() {
  if [[ -n "${ASANA_CLI_INSTALL_DIR:-}" ]]; then
    printf '%s\n' "$ASANA_CLI_INSTALL_DIR"
  elif [[ -d /usr/local/bin && -w /usr/local/bin ]]; then
    printf '/usr/local/bin\n'
  else
    printf '%s/.local/bin\n' "$HOME"
  fi
}

main() {
  local target tag version archive_name download_url
  local archive_path checksum_path install_directory installed_binary
  target="$(detect_target)"
  tag="$(resolve_latest_tag)"
  version="${tag#v}"
  archive_name="asana-cli-${tag}-${target}.tar.gz"
  download_url="https://github.com/${repository}/releases/download/${tag}"
  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/asana-cli-install.XXXXXX")"
  trap cleanup EXIT

  archive_path="${temporary_directory}/${archive_name}"
  checksum_path="${temporary_directory}/SHA256SUMS"
  curl -fsSL "${curl_retry_options[@]}" --output "$archive_path" \
    "${download_url}/${archive_name}"
  curl -fsSL "${curl_retry_options[@]}" --output "$checksum_path" \
    "${download_url}/SHA256SUMS"
  verify_checksum "$temporary_directory" "$archive_name" "$checksum_path"

  tar -xzf "$archive_path" -C "$temporary_directory" asana-cli
  [[ -f "${temporary_directory}/asana-cli" ]] || fail "archive has no asana-cli binary"

  install_directory="$(choose_install_directory)"
  mkdir -p "$install_directory"
  installed_binary="${install_directory}/asana-cli"
  install -m 0755 "${temporary_directory}/asana-cli" "$installed_binary"

  [[ "$("$installed_binary" --version)" == "$version" ]] ||
    fail "installed binary version does not match ${tag}"
  printf 'Installed asana-cli %s to %s\n' "$version" "$installed_binary"
}

main "$@"

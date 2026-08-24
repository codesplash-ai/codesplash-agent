#!/usr/bin/env bash
# Auto-bumps Formula/codesplash-agent.rb in the Homebrew tap named by the BREW_TAP_REPO
# repo variable ("owner/repo"), pushing with the BREW_TAP_TOKEN secret. Inert by design:
# exits 0 with a notice when BREW_TAP_REPO or BREW_TAP_TOKEN is unset. Rewrites the
# formula's version and per-target sha256 lines, computing each sha256 from the released
# artifact files (the same files uploaded to the GitHub release). Seeds the formula from
# packaging/homebrew/codesplash-agent.rb when the tap does not have one yet.
#
# Usage (CI):    BREW_TAP_REPO=owner/repo BREW_TAP_TOKEN=... \
#                  tools/update-brew-tap.sh --version 1.2.3 --artifacts artifacts
# Usage (local): tools/update-brew-tap.sh --version 1.2.3 --artifacts artifacts \
#                  --dry-run --formula path/to/formula.rb   # rewrite only, no clone/push

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
version=""
artifacts_dir=""
dry_run="false"
formula_override=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="$2"; shift 2 ;;
    --artifacts) artifacts_dir="$2"; shift 2 ;;
    --dry-run) dry_run="true"; shift ;;
    --formula) formula_override="$2"; shift 2 ;;
    *) echo "error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ -n "$version" ] || { echo "error: --version is required" >&2; exit 1; }
[ -n "$artifacts_dir" ] || { echo "error: --artifacts is required" >&2; exit 1; }

if [ "$dry_run" = "false" ]; then
  if [ -z "${BREW_TAP_REPO:-}" ]; then
    echo "::notice::BREW_TAP_REPO repo variable not set — Homebrew tap auto-bump skipped"
    exit 0
  fi
  if [ -z "${BREW_TAP_TOKEN:-}" ]; then
    echo "::warning::BREW_TAP_REPO is set but the BREW_TAP_TOKEN secret is not — Homebrew tap auto-bump skipped"
    exit 0
  fi
fi

sha256_of() {
  if [ -n "$(command -v sha256sum || true)" ]; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

artifact_sha() {
  local target="$1"
  local file="${artifacts_dir}/codesplash-agent-${version}-${target}.tar.gz"
  [ -f "$file" ] || { echo "error: released artifact not found: $file" >&2; exit 1; }
  sha256_of "$file"
}

sha_darwin_arm64="$(artifact_sha darwin-arm64)"
sha_darwin_x64="$(artifact_sha darwin-x64)"
sha_linux_x64="$(artifact_sha linux-x64)"
sha_linux_arm64="$(artifact_sha linux-arm64)"

# Rewrites the version line, then each sha256 line with the hash of the target named by
# the url line directly above it. The urls interpolate #{version}, so they never change.
rewrite_formula() {
  local formula="$1"
  awk -v version="$version" \
      -v sha_darwin_arm64="$sha_darwin_arm64" \
      -v sha_darwin_x64="$sha_darwin_x64" \
      -v sha_linux_x64="$sha_linux_x64" \
      -v sha_linux_arm64="$sha_linux_arm64" '
    /^[[:space:]]*version "/ { sub(/"[^"]*"/, "\"" version "\"") }
    /url ".*-darwin-arm64\.tar\.gz"/ { pending = sha_darwin_arm64 }
    /url ".*-darwin-x64\.tar\.gz"/ { pending = sha_darwin_x64 }
    /url ".*-linux-x64\.tar\.gz"/ { pending = sha_linux_x64 }
    /url ".*-linux-arm64\.tar\.gz"/ { pending = sha_linux_arm64 }
    /^[[:space:]]*sha256 "/ && pending != "" { sub(/"[^"]*"/, "\"" pending "\""); pending = "" }
    { print }
  ' "$formula" > "$formula.bump" && mv "$formula.bump" "$formula"
}

if [ "$dry_run" = "true" ]; then
  [ -n "$formula_override" ] || { echo "error: --dry-run requires --formula" >&2; exit 1; }
  rewrite_formula "$formula_override"
  echo "dry run: rewrote $formula_override to version $version (no clone/push)"
  cat "$formula_override"
  exit 0
fi

tap_dir="$(mktemp -d)"
git clone --depth 1 "https://x-access-token:${BREW_TAP_TOKEN}@github.com/${BREW_TAP_REPO}.git" "$tap_dir/tap"
formula_path="$tap_dir/tap/Formula/codesplash-agent.rb"
if [ ! -f "$formula_path" ]; then
  mkdir -p "$tap_dir/tap/Formula"
  cp "$repo_root/packaging/homebrew/codesplash-agent.rb" "$formula_path"
fi
rewrite_formula "$formula_path"

cd "$tap_dir/tap"
if [ -z "$(git status --porcelain)" ]; then
  echo "Formula already at ${version} — nothing to push"
  exit 0
fi
git config user.name "codesplash-release-bot"
git config user.email "release-bot@codesplash.ai"
git add Formula/codesplash-agent.rb
git commit -m "codesplash-agent ${version}"
git push
echo "Pushed codesplash-agent ${version} to ${BREW_TAP_REPO}"

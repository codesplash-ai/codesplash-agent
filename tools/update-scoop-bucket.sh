#!/usr/bin/env bash
# Publishes bucket/codesplash-agent.json in the Scoop bucket named by the SCOOP_BUCKET_REPO
# repo variable ("owner/repo"), pushing with the SCOOP_BUCKET_TOKEN secret. Inert by design:
# exits 0 with a notice when SCOOP_BUCKET_REPO or SCOOP_BUCKET_TOKEN is unset, and when the
# experimental Windows build produced no artifact. Renders the manifest from
# packaging/scoop/codesplash-agent.json with the released version and zip sha256.
#
# Usage (CI):    SCOOP_BUCKET_REPO=owner/repo SCOOP_BUCKET_TOKEN=... \
#                  tools/update-scoop-bucket.sh --version 1.2.3 --artifacts artifacts
# Usage (local): tools/update-scoop-bucket.sh --version 1.2.3 --artifacts artifacts \
#                  --dry-run --manifest path/to/manifest.json   # rewrite only, no clone/push

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
version=""
artifacts_dir=""
dry_run="false"
manifest_override=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="$2"; shift 2 ;;
    --artifacts) artifacts_dir="$2"; shift 2 ;;
    --dry-run) dry_run="true"; shift ;;
    --manifest) manifest_override="$2"; shift 2 ;;
    *) echo "error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ -n "$version" ] || { echo "error: --version is required" >&2; exit 1; }
[ -n "$artifacts_dir" ] || { echo "error: --artifacts is required" >&2; exit 1; }

if [ "$dry_run" = "false" ]; then
  if [ -z "${SCOOP_BUCKET_REPO:-}" ]; then
    echo "::notice::SCOOP_BUCKET_REPO repo variable not set — Scoop bucket update skipped"
    exit 0
  fi
  if [ -z "${SCOOP_BUCKET_TOKEN:-}" ]; then
    echo "::warning::SCOOP_BUCKET_REPO is set but the SCOOP_BUCKET_TOKEN secret is not — Scoop bucket update skipped"
    exit 0
  fi
fi

zip_file="${artifacts_dir}/codesplash-agent-${version}-win32-x64.zip"
if [ ! -f "$zip_file" ]; then
  echo "::notice::${zip_file} not found (experimental Windows build likely failed) — Scoop bucket update skipped"
  exit 0
fi

if [ -n "$(command -v sha256sum || true)" ]; then
  zip_sha="$(sha256sum "$zip_file" | awk '{print $1}')"
else
  zip_sha="$(shasum -a 256 "$zip_file" | awk '{print $1}')"
fi

render_manifest() {
  local out="$1"
  jq --arg version "$version" --arg hash "$zip_sha" '
    .version = $version
    | .architecture."64bit".url =
        "https://github.com/codesplash-ai/codesplash-agent/releases/download/v\($version)/codesplash-agent-\($version)-win32-x64.zip"
    | .architecture."64bit".hash = $hash
  ' "$repo_root/packaging/scoop/codesplash-agent.json" > "$out"
}

if [ "$dry_run" = "true" ]; then
  [ -n "$manifest_override" ] || { echo "error: --dry-run requires --manifest" >&2; exit 1; }
  render_manifest "$manifest_override"
  echo "dry run: rendered $manifest_override at version $version (no clone/push)"
  cat "$manifest_override"
  exit 0
fi

bucket_dir="$(mktemp -d)"
git clone --depth 1 "https://x-access-token:${SCOOP_BUCKET_TOKEN}@github.com/${SCOOP_BUCKET_REPO}.git" "$bucket_dir/bucket-repo"
mkdir -p "$bucket_dir/bucket-repo/bucket"
render_manifest "$bucket_dir/bucket-repo/bucket/codesplash-agent.json"

cd "$bucket_dir/bucket-repo"
if [ -z "$(git status --porcelain)" ]; then
  echo "Manifest already at ${version} — nothing to push"
  exit 0
fi
git config user.name "codesplash-release-bot"
git config user.email "release-bot@codesplash.ai"
git add bucket/codesplash-agent.json
git commit -m "codesplash-agent ${version}"
git push
echo "Pushed codesplash-agent ${version} to ${SCOOP_BUCKET_REPO}"

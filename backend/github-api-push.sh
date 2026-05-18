#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# github-api-push.sh
# Pushes all backend/ files to GitHub using the REST API (no git required).
# Usage:  GITHUB_TOKEN=ghp_xxxx bash github-api-push.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

OWNER="Sparkflyer1"
REPO="mcm-dashboard"
BRANCH="main"
TOKEN="${GITHUB_TOKEN:-}"

if [ -z "$TOKEN" ]; then
  echo "ERROR: Set GITHUB_TOKEN before running."
  echo "  export GITHUB_TOKEN=ghp_your_token_here"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

push_file() {
  local local_path="$1"
  local remote_path="$2"

  local content
  content=$(base64 < "$local_path" | tr -d '\n')

  # Get current SHA if file exists (needed for updates)
  local sha
  sha=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "https://api.github.com/repos/$OWNER/$REPO/contents/$remote_path?ref=$BRANCH" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sha',''))" 2>/dev/null || true)

  local payload
  if [ -n "$sha" ]; then
    payload=$(printf '{"message":"chore: update %s","content":"%s","sha":"%s","branch":"%s"}' \
      "$remote_path" "$content" "$sha" "$BRANCH")
  else
    payload=$(printf '{"message":"feat: add %s","content":"%s","branch":"%s"}' \
      "$remote_path" "$content" "$BRANCH")
  fi

  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PUT \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "https://api.github.com/repos/$OWNER/$REPO/contents/$remote_path")

  if [[ "$status" == "200" || "$status" == "201" ]]; then
    echo "  ✅  $remote_path ($status)"
  else
    echo "  ❌  $remote_path failed (HTTP $status)"
  fi
}

echo "➜  Pushing backend/ to github.com/$OWNER/$REPO …"

push_file "$SCRIPT_DIR/src/index.ts"      "backend/src/index.ts"
push_file "$SCRIPT_DIR/wrangler.toml"     "backend/wrangler.toml"
push_file "$SCRIPT_DIR/package.json"      "backend/package.json"
push_file "$SCRIPT_DIR/tsconfig.json"     "backend/tsconfig.json"
push_file "$SCRIPT_DIR/README.md"         "backend/README.md"

echo ""
echo "Done! View at: https://github.com/$OWNER/$REPO/tree/$BRANCH/backend"

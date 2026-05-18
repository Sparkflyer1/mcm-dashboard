#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Run this from your local machine inside the mcm-dashboard repo root.
# Requires: git, and that you've cloned the repo already.
#
# Usage:
#   cd /path/to/mcm-dashboard
#   cp -r /path/to/outputs/backend ./backend   # copy the files Claude built
#   bash backend/push-to-github.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

echo "➜  Staging backend/..."
git add backend/

echo "➜  Committing..."
git commit -m "feat: add Cloudflare Worker backend (Strava OAuth 2.0 + API proxy)

- GET  /auth        → redirect to Strava OAuth consent
- GET  /callback    → token exchange, stores access+refresh tokens in KV
- ANY  /strava/*    → authenticated proxy to Strava API v3 (auto-refresh)

KV namespace: strava-auth-store (e4f95c0b2677460baba8496b95b6b78f)
Strava client ID: 246990"

echo "➜  Pushing to origin/main..."
git push origin main

echo ""
echo "✅  Done! View at: https://github.com/Sparkflyer1/mcm-dashboard/tree/main/backend"

# MCM Dashboard — Project Context (read this first)

Personal single-user marathon-training dashboard for Tyler (Marine Corps Marathon, Oct 2026).
This file is auto-loaded when the folder is connected — start here before doing any work.

## Architecture (3 pieces)
1. **Frontend** — `frontend/index.html`. ONE self-contained file (HTML + CSS + 2 inline `<script>` blocks).
   No build step. Has a desktop shell (`#desktop-shell`) and a mobile shell (`#mobile-shell`),
   toggled by a media query (~1004px). Mobile fns are prefixed `m`/`mRender*`; desktop `render*`.
   Libs via CDN: Chart.js, Lucide icons, canvas-confetti.
   Live at **https://mcm.tyleresterly.com** via Cloudflare Pages (auto-deploys on git push to `main`).
2. **Backend** — `backend/src/index.ts`. Cloudflare Worker at
   **https://mcm-strava-worker.tyleresterly.workers.dev**. Handles Strava OAuth, a Strava API proxy
   (`/strava/*`), Strava→Supabase sync (`/strava/sync`, also a 6-hourly cron), and Supabase-backed
   plan/nutrition/activity endpoints. Secrets + Strava tokens live in Cloudflare KV (`STRAVA_KV`).
3. **Database** — Supabase project **"Tyler MCM Dashboard"** (id `pcbcuawqfdhtzzlqvatb`), Postgres.

## Deploy flow (IMPORTANT — nothing is live until you do this)
- **Frontend (PREFERRED — Tyler's standing choice): use GitHub Desktop.** After editing
  `frontend/index.html`, open the `mcm-dashboard` repo in GitHub Desktop, write a summary,
  click "Commit to main", then "Push origin". Cloudflare Pages auto-deploys on push.
  GitHub Desktop stays signed in, so no token prompts. ALWAYS deploy this way — do NOT use the
  Terminal/`push-dashboard.command` route (it prompts for GitHub credentials, which Claude cannot enter).
  Claude can stage the commit and drive GitHub Desktop up to the final "Push origin" click.
- **Worker:** `deploy-worker.command` runs `npx wrangler deploy` from `backend/` (only when backend changes).
  `git push` alone does NOT deploy the Worker.
- **Database:** Supabase migrations apply immediately via the Supabase MCP — no deploy step.

## Single-user model (no real auth)
Everything is keyed to a fixed anon UUID `00000000-0000-0000-0000-000000000001`.
There are NO rows in `auth.users`. So:
- Do NOT add foreign keys to `auth.users` (they reject every insert). They were dropped on purpose.
- Every table needs explicit **anon** RLS policies (SELECT + INSERT/UPDATE). RLS is ON for all tables;
  a table with RLS on and no anon policy silently rejects all writes from the Worker (anon key).

## PIN gate (frontend)
A simple client-side PIN lock (`#pin-lock`) sits at the very top of `<body>` in `frontend/index.html`
with its own inline `<style>` + `<script>`. It is a privacy curtain, NOT real security (data is behind
the public Supabase anon key). PIN is obfuscated as base64 in `EXPECTED` (currently btoa of the 4-digit
code). A successful unlock writes `mcm_pin_until` (now + 30 days) to localStorage and hides the overlay;
on load, a still-valid timestamp skips the gate. To change the PIN, replace `EXPECTED` with the new
`btoa('XXXX')` value. To reset the lock on a device, clear localStorage key `mcm_pin_until`.

## Key tables
- `training_plan` (148 rows) — the plan. Date column is **`workout_date`** (not `date`).
  Raw `week_number` runs -2,-1,0 (3 base-building weeks: Jun 1-21) then 1..18 (Hal Higdon 18-week
  plan, starts **Jun 22 2026**). The UI renumbers for display (offset = 1 - minWeek, so today = Week 1)
  and computes the "of N Weeks" total from the data so the last week always lands on race day
  (Oct 26 2026). A "Hal Higdon starts" tag/countdown shows in the banner + Plan tab. See dSyncCountdown().
- `workout_log`, `plan_completions` — workout logging. `plan_completions` is unique on (user_id, plan_id).
  NOTE: `plan_completions` has no `status` column, so a "skip" looks the same as "done" after refresh.
- `strava_activities` — synced from Strava, PK `strava_id`, upsert merges on it.
- `cross_training_log` / `cross_training_options`, `nutrition_log` / `user_nutrition_profile` /
  `workout_nutrition_guidelines`.

## Strava sync — how it works (verified working)
- `/strava/sync` reads `last_synced_at` from KV and passes `&after=` so it only fetches NEW activities
  (delta sync — never re-pulls everything). Upserts on `strava_id`. Updates `last_synced_at` only on
  a successful write. Cron runs every 6h. Synced types: Run, TrailRun, Walk, Hike, Ride.
- Frontend auto-completes today's planned workout if a matching Strava run exists that day
  (`autoCompleteFromStrava()` in init) — no button click needed.

## Known gotchas (learned the hard way — see AGENT_NOTES.md for more)
- `const`/`let` at top of one `<script>` block are NOT on `window`; other blocks calling `window.X`
  fail silently. Expose shared values with `window.X = X`.
- Chart.js/maps inside hidden tabs init at 0×0 — render on first tab show, then `.resize()`.
- Mobile shell uses `height: 100dvh` (not 100vh) so the bottom nav stays pinned above the address bar.
- Weather (open-meteo, client-side) uses stale-while-revalidate: cached value shows instantly, then refreshes.
- After any edit, check for duplicate `id=` attributes and run a JS syntax check before deploying.

## Quick verification commands
- Strava connected? `GET https://mcm-strava-worker.tyleresterly.workers.dev/strava/athlete`
- Trigger a sync: `GET .../strava/sync`
- DB checks: use the Supabase MCP (`execute_sql`, project id `pcbcuawqfdhtzzlqvatb`).

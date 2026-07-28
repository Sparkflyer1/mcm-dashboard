/**
 * MCM Dashboard — Cloudflare Worker
 *
 * Routes:
 *   GET  /auth               → Redirect user to Strava OAuth
 *   GET  /callback           → Exchange code for tokens; store in KV
 *   ANY  /strava/*           → Proxy authenticated requests to Strava API v3
 *   GET  /plan/today         → Today's workout from Supabase training_plan
 *   GET  /plan/week          → Current week's 7 workouts from Supabase
 *   GET  /plan/completion    → Today's completion status from plan_completions
 *   POST /plan/log           → Write workout completion to Supabase
 *   GET  /plan/all           → All training_plan rows ordered by workout_date ASC
 *
 * KV keys (STRAVA_KV namespace):
 *   STRAVA_CLIENT_SECRET  – set via Wrangler or CF dashboard
 *   strava_tokens         – JSON: { access_token, refresh_token, expires_at }
 *
 * Env vars (wrangler.toml):
 *   STRAVA_CLIENT_ID, REDIRECT_URI, SUPABASE_URL, SUPABASE_ANON_KEY, ALLOWED_ORIGIN
 */

export interface Env {
  STRAVA_KV: KVNamespace;
  STRAVA_CLIENT_ID: string;
  REDIRECT_URI: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  ALLOWED_ORIGIN: string;
}

interface StravaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
  athlete?: Record<string, unknown>;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const STRAVA_AUTH_URL  = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_API_BASE  = "https://www.strava.com/api/v3";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_SCOPE = "read,activity:read_all,profile:read_all";
const ANON_USER_ID  = "00000000-0000-0000-0000-000000000001";

// ─── CORS ─────────────────────────────────────────────────────────────────────
function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allowedOrigin = (origin === env.ALLOWED_ORIGIN) ? origin : env.ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin":      allowedOrigin,
    "Access-Control-Allow-Methods":     "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers":     "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
  };
}

function jsonResponse(body: unknown, status = 200, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

// ─── Strava token helpers ─────────────────────────────────────────────────────
async function loadTokens(env: Env): Promise<StravaTokens | null> {
  const raw = await env.STRAVA_KV.get("strava_tokens");
  if (!raw) return null;
  return JSON.parse(raw) as StravaTokens;
}

async function refreshTokens(env: Env, tokens: StravaTokens): Promise<StravaTokens> {
  const clientSecret = await env.STRAVA_KV.get("STRAVA_CLIENT_SECRET");
  if (!clientSecret) throw new Error("STRAVA_CLIENT_SECRET not in KV");

  const resp = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     env.STRAVA_CLIENT_ID,
      client_secret: clientSecret,
      grant_type:    "refresh_token",
      refresh_token: tokens.refresh_token,
    }).toString(),
  });

  if (!resp.ok) throw new Error(`Token refresh failed (${resp.status}): ${await resp.text()}`);
  const refreshed = (await resp.json()) as StravaTokens;
  await env.STRAVA_KV.put("strava_tokens", JSON.stringify(refreshed));
  return refreshed;
}

async function getValidAccessToken(env: Env): Promise<string> {
  const tokens = await loadTokens(env);
  if (!tokens) throw new Error("No Strava tokens found. Visit /auth to authenticate.");
  if (tokens.expires_at * 1000 < Date.now() + REFRESH_BUFFER_MS) {
    const refreshed = await refreshTokens(env, tokens);
    return refreshed.access_token;
  }
  return tokens.access_token;
}

// ─── Supabase helper ──────────────────────────────────────────────────────────
async function supabase(
  env: Env,
  path: string,
  method = "GET",
  body?: unknown
): Promise<Response> {
  const url = `${env.SUPABASE_URL}/rest/v1/${path}`;
  const headers: Record<string, string> = {
    "apikey":        env.SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
    "Content-Type":  "application/json",
    "Prefer":        "return=representation",
  };
  return fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ─── ISO week helpers ─────────────────────────────────────────────────────────
function toLocalDateStr(date: Date, tz = "America/New_York"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function weekBounds(tz = "America/New_York"): { mon: string; sun: string } {
  const now = new Date();
  const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const dow = local.getDay(); // 0=Sun … 6=Sat
  const diffToMon = (dow === 0 ? -6 : 1 - dow);
  const mon = new Date(local);
  mon.setDate(local.getDate() + diffToMon);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return {
    mon: `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,"0")}-${String(mon.getDate()).padStart(2,"0")}`,
    sun: `${sun.getFullYear()}-${String(sun.getMonth()+1).padStart(2,"0")}-${String(sun.getDate()).padStart(2,"0")}`,
  };
}

// ─── Route handlers ───────────────────────────────────────────────────────────

function handleAuth(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope") ?? DEFAULT_SCOPE;
  const authUrl = new URL(STRAVA_AUTH_URL);
  authUrl.searchParams.set("client_id",       env.STRAVA_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri",    env.REDIRECT_URI);
  authUrl.searchParams.set("response_type",   "code");
  authUrl.searchParams.set("scope",           scope);
  authUrl.searchParams.set("approval_prompt", "auto");
  return Response.redirect(authUrl.toString(), 302);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code  = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const cors  = corsHeaders(env, request.headers.get("Origin"));

  if (error) return jsonResponse({ error: `Strava OAuth error: ${error}` }, 400, cors);
  if (!code)  return jsonResponse({ error: "Missing 'code' query parameter" }, 400, cors);

  const clientSecret = await env.STRAVA_KV.get("STRAVA_CLIENT_SECRET");
  if (!clientSecret)
    return jsonResponse({ error: "STRAVA_CLIENT_SECRET not configured." }, 500, cors);

  const tokenResp = await fetch(STRAVA_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     env.STRAVA_CLIENT_ID,
      client_secret: clientSecret,
      code,
      grant_type:    "authorization_code",
      redirect_uri:  env.REDIRECT_URI,
    }).toString(),
  });

  if (!tokenResp.ok) {
    const detail = await tokenResp.text();
    return jsonResponse({ error: "Token exchange failed", detail }, tokenResp.status, cors);
  }

  const tokens = (await tokenResp.json()) as StravaTokens;
  const { athlete, ...tokensToStore } = tokens;
  await env.STRAVA_KV.put("strava_tokens", JSON.stringify(tokensToStore));

  // Redirect back to dashboard after successful auth
  return Response.redirect("https://mcm.tyleresterly.com/?connected=1", 302);
}

async function handleStravaProxy(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env, request.headers.get("Origin"));
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(env);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 401, cors);
  }

  const url = new URL(request.url);
  const stravaPath  = url.pathname.replace(/^\/strava/, "") || "/";
  const upstreamUrl = new URL(STRAVA_API_BASE + stravaPath);
  url.searchParams.forEach((v, k) => upstreamUrl.searchParams.set(k, v));

  const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase());
  const upstreamResp = await fetch(upstreamUrl.toString(), {
    method:  request.method,
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept:         "application/json",
    },
    body: hasBody ? request.body : undefined,
  });

  const responseBody = await upstreamResp.text();
  return new Response(responseBody, {
    status: upstreamResp.status,
    headers: {
      "Content-Type": upstreamResp.headers.get("Content-Type") ?? "application/json",
      ...cors,
    },
  });
}

/** GET /plan/today — today's workout row from training_plan */
async function handlePlanToday(request: Request, env: Env): Promise<Response> {
  const cors  = corsHeaders(env, request.headers.get("Origin"));
  const today = toLocalDateStr(new Date());
  const resp  = await supabase(env, `training_plan?workout_date=eq.${today}&select=*`);

  if (!resp.ok) return jsonResponse({ error: "Supabase error" }, 502, cors);
  const rows = (await resp.json()) as unknown[];
  if (!rows.length) return jsonResponse({ error: "No plan for today", date: today }, 404, cors);
  return jsonResponse(rows[0], 200, cors);
}

/** GET /plan/week — Mon–Sun workouts from training_plan */
async function handlePlanWeek(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env, request.headers.get("Origin"));
  const { mon, sun } = weekBounds();
  const resp = await supabase(
    env,
    `training_plan?workout_date=gte.${mon}&workout_date=lte.${sun}&select=*&order=workout_date.asc`
  );
  if (!resp.ok) return jsonResponse({ error: "Supabase error" }, 502, cors);
  const rows = await resp.json();
  return jsonResponse(rows, 200, cors);
}

/** GET /plan/completion — today's completion from plan_completions */
async function handlePlanCompletion(request: Request, env: Env): Promise<Response> {
  const cors  = corsHeaders(env, request.headers.get("Origin"));
  const today = toLocalDateStr(new Date());

  // Step 1: get today's plan row to obtain its id
  const planResp = await supabase(env, `training_plan?workout_date=eq.${today}&select=id`);
  if (!planResp.ok) return jsonResponse({ error: "Supabase error" }, 502, cors);
  const planRows = (await planResp.json()) as { id: number }[];
  if (!planRows.length) return jsonResponse(null, 200, cors);
  const planId = planRows[0].id;

  // Step 2: get most recent completion for that plan row
  const compResp = await supabase(
    env,
    `plan_completions?plan_id=eq.${planId}&order=created_at.desc&limit=1`
  );
  if (!compResp.ok) return jsonResponse({ error: "Supabase error" }, 502, cors);
  const compRows = (await compResp.json()) as unknown[];
  return jsonResponse(compRows[0] ?? null, 200, cors);
}

/** POST /plan/log — log a workout completion */
async function handlePlanLog(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env, request.headers.get("Origin"));
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, cors);
  }

  const {
    status,           // "done" | "skip"
    plan_id,          // integer from training_plan.id
    workout_type,
    distance_miles,
    duration_minutes,
    avg_heart_rate,
    perceived_effort,
    notes,
  } = body;

  const today = toLocalDateStr(new Date());
  const workoutDate = (body.workout_date as string) || today;
  // ANON_USER_ID is defined at module scope

  // Only write a real log entry for "done"
  let workoutLogId: string | null = null;
  if (status === "done") {
    const logResp = await supabase(env, "workout_log", "POST", {
      user_id:          ANON_USER_ID,
      plan_id:          plan_id ?? null,
      workout_date:     workoutDate,
      workout_type:     workout_type ?? "easy_run",
      distance_miles:   distance_miles ?? null,
      duration_minutes: duration_minutes ?? null,
      avg_heart_rate:   avg_heart_rate ?? null,
      perceived_effort: perceived_effort ?? null,
      notes:            notes ?? null,
    });
    if (logResp.ok) {
      const logRows = (await logResp.json()) as { id: string }[];
      workoutLogId = logRows[0]?.id ?? null;
    }
  }

  // Always write a plan_completion record (upsert to prevent duplicates)
  if (plan_id) {
    const upsertUrl = `${env.SUPABASE_URL}/rest/v1/plan_completions?on_conflict=user_id,plan_id`;
    await fetch(upsertUrl, {
      method: "POST",
      headers: {
        "apikey":        env.SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify({
        user_id:        ANON_USER_ID,
        plan_id,
        workout_log_id: workoutLogId,
      }),
    });
  }

  return jsonResponse({ success: true, status, date: today, workout_log_id: workoutLogId }, 200, cors);
}

// Activity types to sync from Strava
const SYNC_ACTIVITY_TYPES = new Set(["Run", "TrailRun", "Walk", "Hike", "Ride"]);

/** GET /strava/sync — fetch Strava activities and upsert into Supabase */
async function handleStravaSync(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env, request.headers.get("Origin"));
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(env);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 401, cors);
  }

  // Delta sync: only fetch activities newer than last sync
  const lastSyncedAt = await env.STRAVA_KV.get("last_synced_at");
  const afterParam = lastSyncedAt ? `&after=${lastSyncedAt}` : "";

  // Fetch up to 2 pages of activities from Strava
  const allActivities: Record<string, unknown>[] = [];
  for (let page = 1; page <= 2; page++) {
    const resp = await fetch(
      `${STRAVA_API_BASE}/athlete/activities?per_page=100&page=${page}${afterParam}`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } }
    );
    if (!resp.ok) {
      if (page === 1) {
        return jsonResponse({ error: `Strava API error (${resp.status})`, detail: await resp.text() }, 502, cors);
      }
      break;
    }
    const activities = (await resp.json()) as Record<string, unknown>[];
    if (!activities.length) break;
    allActivities.push(...activities);
    if (activities.length < 100) break;
  }

  // Filter to supported activity types
  const filtered = allActivities.filter(a => SYNC_ACTIVITY_TYPES.has(a.type as string));

  if (!filtered.length) {
    return jsonResponse({ synced: 0, total: allActivities.length }, 200, cors);
  }

  // Build upsert rows
  const rows = filtered.map(a => ({
    strava_id:         a.id,
    user_id:           ANON_USER_ID,
    activity_type:     a.type,
    name:              a.name,
    distance:          a.distance,
    moving_time:       a.moving_time,
    elapsed_time:      a.elapsed_time,
    average_heartrate: a.average_heartrate ?? null,
    max_heartrate:     a.max_heartrate ?? null,
    average_speed:     a.average_speed ?? null,
    suffer_score:      a.suffer_score ?? null,
    start_date_local:  a.start_date_local,
    gear_id:           a.gear_id ?? null,
    updated_at:        new Date().toISOString(),
  }));

  // Upsert via Supabase REST — merge on strava_id
  const upsertUrl = `${env.SUPABASE_URL}/rest/v1/strava_activities?on_conflict=strava_id`;
  const upsertResp = await fetch(upsertUrl, {
    method: "POST",
    headers: {
      "apikey":        env.SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
      "Content-Type":  "application/json",
      "Prefer":        "resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  });

  if (!upsertResp.ok) {
    const detail = await upsertResp.text();
    return jsonResponse({ error: "Supabase upsert failed", detail }, 502, cors);
  }

  // Record sync timestamp for delta fetches next time
  await env.STRAVA_KV.put("last_synced_at", String(Math.floor(Date.now() / 1000)));

  return jsonResponse({ synced: rows.length, total: allActivities.length }, 200, cors);
}

/** GET /activities/list — recent activities from strava_activities in Supabase */
async function handleActivitiesList(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env, request.headers.get("Origin"));
  const resp = await supabase(
    env,
    `strava_activities?user_id=eq.${ANON_USER_ID}&select=strava_id,activity_type,name,distance,moving_time,average_heartrate,start_date_local,gear_id&order=start_date_local.desc&limit=50`
  );
  if (!resp.ok) return jsonResponse({ error: "Supabase error" }, 502, cors);
  const rows = await resp.json();
  return jsonResponse(rows, 200, cors);
}

/** GET /activities/summary — computed stats from strava_activities in Supabase */
async function handleActivitiesSummary(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env, request.headers.get("Origin"));

  // Fetch all Run/TrailRun activities
  const resp = await supabase(
    env,
    `strava_activities?user_id=eq.${ANON_USER_ID}&activity_type=in.(Run,TrailRun)&select=distance,moving_time,average_speed,start_date_local&order=start_date_local.desc`
  );
  if (!resp.ok) return jsonResponse({ error: "Supabase error" }, 502, cors);

  interface ActivityRow {
    distance: number;
    moving_time: number;
    average_speed: number | null;
    start_date_local: string;
  }
  const activities = (await resp.json()) as ActivityRow[];

  const METERS_PER_MILE = 1609.34;
  const now = new Date();

  // Week bounds (Monday of current week)
  const { mon } = weekBounds();
  const monDate = new Date(mon + "T00:00:00");

  // All-time stats
  let allTimeMiles = 0;
  let allTimeRuns  = 0;
  let longestRunMi = 0;

  // This week
  let thisWeekMiles = 0;
  let thisWeekRuns  = 0;

  // 30-day pace
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  let pace30dTotalSec  = 0;
  let pace30dCount     = 0;

  // Streak: collect weeks with runs
  const weekMilesMap: Map<string, number> = new Map();

  for (const act of activities) {
    const distMi = act.distance / METERS_PER_MILE;
    const actDate = new Date(act.start_date_local);

    allTimeMiles += distMi;
    allTimeRuns++;
    if (distMi > longestRunMi) longestRunMi = distMi;

    if (actDate >= monDate) {
      thisWeekMiles += distMi;
      thisWeekRuns++;
    }

    if (actDate >= thirtyDaysAgo && act.moving_time > 0 && distMi > 0) {
      const secPerMile = act.moving_time / distMi;
      pace30dTotalSec += secPerMile;
      pace30dCount++;
    }

    // Compute ISO-ish week key (Monday of that week)
    const d = new Date(actDate);
    const dow = d.getDay(); // 0=Sun
    const diffToMon = dow === 0 ? -6 : 1 - dow;
    d.setDate(d.getDate() + diffToMon);
    const weekKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    weekMilesMap.set(weekKey, (weekMilesMap.get(weekKey) ?? 0) + distMi);
  }

  // Best week
  let bestWeekMi = 0;
  for (const mi of weekMilesMap.values()) {
    if (mi > bestWeekMi) bestWeekMi = mi;
  }

  // Streak: consecutive non-zero weeks going back from current week
  let streak = 0;
  const checkDate = new Date(monDate);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const key = `${checkDate.getFullYear()}-${String(checkDate.getMonth()+1).padStart(2,"0")}-${String(checkDate.getDate()).padStart(2,"0")}`;
    if ((weekMilesMap.get(key) ?? 0) > 0) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 7);
    } else {
      break;
    }
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;

  return jsonResponse({
    thisWeekMiles:  round2(thisWeekMiles),
    thisWeekRuns,
    allTimeMiles:   round2(allTimeMiles),
    allTimeRuns,
    streak,
    avgPace30dSec:  pace30dCount > 0 ? Math.round(pace30dTotalSec / pace30dCount) : 0,
    longestRunMi:   round2(longestRunMi),
    bestWeekMi:     round2(bestWeekMi),
  }, 200, cors);
}

/** GET /plan/all — all training_plan rows ordered by workout_date ASC */
async function handlePlanAll(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env, request.headers.get("Origin"));
  const resp = await supabase(env, `training_plan?select=*&order=workout_date.asc`);
  if (!resp.ok) return jsonResponse({ error: "Supabase error" }, 502, cors);
  const rows = await resp.json();
  return jsonResponse(rows, 200, cors);
}

/** GET /plan/completions — all completions for the user, with each plan day's date */
async function handlePlanCompletions(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env, request.headers.get("Origin"));
  const resp = await supabase(
    env,
    `plan_completions?user_id=eq.${ANON_USER_ID}&select=*,training_plan(workout_date)`
  );
  if (!resp.ok) return jsonResponse({ error: "Supabase error" }, 502, cors);
  return jsonResponse(await resp.json(), 200, cors);
}

/** POST /plan/uncomplete — remove a completion (and its workout_log) for a plan day */
async function handlePlanUncomplete(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env, request.headers.get("Origin"));
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400, cors); }
  const plan_id = body.plan_id;
  if (plan_id == null) return jsonResponse({ error: "plan_id required" }, 400, cors);

  // Delete the completion row, then any workout_log rows for that plan day.
  const delComp = await supabase(env, `plan_completions?user_id=eq.${ANON_USER_ID}&plan_id=eq.${plan_id}`, "DELETE");
  await supabase(env, `workout_log?user_id=eq.${ANON_USER_ID}&plan_id=eq.${plan_id}`, "DELETE");
  if (!delComp.ok) return jsonResponse({ error: "Supabase delete failed", detail: await delComp.text() }, 502, cors);
  return jsonResponse({ success: true, plan_id }, 200, cors);
}

// ─── Main fetch handler ───────────────────────────────────────────────────────
export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Auto-sync Strava every 6 hours via cron trigger
    const req = new Request("https://internal/strava/sync");
    await handleStravaSync(req, env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const cors   = corsHeaders(env, origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url      = new URL(request.url);
    const pathname = url.pathname;

    try {
      // Strava OAuth
      if (pathname === "/auth" || pathname === "/strava/auth") return handleAuth(request, env);
      if (pathname === "/callback")                             return handleCallback(request, env);

      // Strava-specific routes (before generic proxy)
      if (pathname === "/strava/sync" && request.method === "GET") return handleStravaSync(request, env);

      if (pathname.startsWith("/strava"))                      return handleStravaProxy(request, env);

      // Plan / Supabase
      if (pathname === "/plan/today"      && request.method === "GET")  return handlePlanToday(request, env);
      if (pathname === "/plan/week"       && request.method === "GET")  return handlePlanWeek(request, env);
      if (pathname === "/plan/completion" && request.method === "GET")  return handlePlanCompletion(request, env);
      if (pathname === "/plan/log"        && request.method === "POST") return handlePlanLog(request, env);
      if (pathname === "/plan/all"        && request.method === "GET")  return handlePlanAll(request, env);
      if (pathname === "/plan/completions" && request.method === "GET")  return handlePlanCompletions(request, env);
      if (pathname === "/plan/uncomplete"  && request.method === "POST") return handlePlanUncomplete(request, env);

      // Activities
      if (pathname === "/activities/list"    && request.method === "GET") return handleActivitiesList(request, env);
      if (pathname === "/activities/summary" && request.method === "GET") return handleActivitiesSummary(request, env);

      // Health check
      if (pathname === "/" || pathname === "/health") {
        return jsonResponse({
          service: "mcm-dashboard worker",
          status:  "ok",
          routes: {
            "GET  /auth":             "Redirect to Strava OAuth",
            "GET  /callback":         "OAuth callback",
            "ANY  /strava/*":         "Strava API proxy",
            "GET  /plan/today":       "Today's Supabase workout",
            "GET  /plan/week":        "This week's Supabase workouts",
            "GET  /plan/completion":  "Today's completion status",
            "POST /plan/log":         "Log workout completion",
            "GET  /plan/all":            "All training plan rows",
            "GET  /strava/sync":         "Sync Strava activities to Supabase",
            "GET  /activities/list":     "Recent activities from Supabase",
            "GET  /activities/summary":  "Computed activity stats from Supabase",
          },
        }, 200, cors);
      }

      return jsonResponse({ error: "Not found" }, 404, cors);
    } catch (err) {
      return jsonResponse({ error: "Internal server error", detail: (err as Error).message }, 500, cors);
    }
  },
};

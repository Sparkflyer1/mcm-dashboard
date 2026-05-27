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

// ─── CORS ─────────────────────────────────────────────────────────────────────
function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allowed = [
    env.ALLOWED_ORIGIN,
    "http://localhost:3000",
    "http://localhost:8080",
    "http://127.0.0.1:5500",
  ];
  const allowedOrigin = (origin && allowed.includes(origin)) ? origin : env.ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin":      allowedOrigin,
    "Access-Control-Allow-Methods":     "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers":     "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
  };
}

function jsonResponse(body: unknown, status = 200, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
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
  // Join plan_completions with training_plan to get today's record
  const resp  = await supabase(
    env,
    `plan_completions?select=*,training_plan!plan_id(workout_date)` +
    `&training_plan.workout_date=eq.${today}&order=created_at.desc&limit=1`
  );
  if (!resp.ok) return jsonResponse({ error: "Supabase error" }, 502, cors);
  const rows = await resp.json() as unknown[];
  return jsonResponse(rows[0] ?? null, 200, cors);
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
  const ANON_USER_ID = "00000000-0000-0000-0000-000000000001"; // fixed for single-user app

  // Only write a real log entry for "done"
  let workoutLogId: string | null = null;
  if (status === "done") {
    const logResp = await supabase(env, "workout_log", "POST", {
      user_id:          ANON_USER_ID,
      plan_id:          plan_id ?? null,
      workout_date:     today,
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

  // Always write a plan_completion record
  if (plan_id) {
    await supabase(env, "plan_completions", "POST", {
      user_id:        ANON_USER_ID,
      plan_id,
      workout_log_id: workoutLogId,
    });
  }

  return jsonResponse({ success: true, status, date: today, workout_log_id: workoutLogId }, 200, cors);
}

// ─── Main fetch handler ───────────────────────────────────────────────────────
export default {
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
      if (pathname.startsWith("/strava"))                      return handleStravaProxy(request, env);

      // Plan / Supabase
      if (pathname === "/plan/today"      && request.method === "GET")  return handlePlanToday(request, env);
      if (pathname === "/plan/week"       && request.method === "GET")  return handlePlanWeek(request, env);
      if (pathname === "/plan/completion" && request.method === "GET")  return handlePlanCompletion(request, env);
      if (pathname === "/plan/log"        && request.method === "POST") return handlePlanLog(request, env);

      // Health check
      if (pathname === "/" || pathname === "/health") {
        return jsonResponse({
          service: "mcm-dashboard worker",
          status:  "ok",
          routes: {
            "GET  /auth":            "Redirect to Strava OAuth",
            "GET  /callback":        "OAuth callback",
            "ANY  /strava/*":        "Strava API proxy",
            "GET  /plan/today":      "Today's Supabase workout",
            "GET  /plan/week":       "This week's Supabase workouts",
            "GET  /plan/completion": "Today's completion status",
            "POST /plan/log":        "Log workout completion",
          },
        }, 200, cors);
      }

      return jsonResponse({ error: "Not found" }, 404, cors);
    } catch (err) {
      return jsonResponse({ error: "Internal server error", detail: (err as Error).message }, 500, cors);
    }
  },
};

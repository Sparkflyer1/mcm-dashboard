/**
 * Strava OAuth + Proxy — Cloudflare Worker
 *
 * Routes:
 *   GET  /auth          → Redirect user to Strava's OAuth consent screen
 *   GET  /callback      → Exchange authorization code for tokens; persist in KV
 *   ANY  /strava/*      → Proxy authenticated requests to Strava API v3
 *
 * KV keys (namespace: STRAVA_KV):
 *   STRAVA_CLIENT_SECRET  – set manually via Wrangler or the CF dashboard
 *   strava_tokens         – JSON: { access_token, refresh_token, expires_at, ... }
 *
 * Environment variables (wrangler.toml [vars]):
 *   STRAVA_CLIENT_ID  – your Strava app's client ID (246990)
 *   REDIRECT_URI      – full callback URL, e.g. https://<worker>.workers.dev/callback
 */

export interface Env {
  STRAVA_KV: KVNamespace;
  STRAVA_CLIENT_ID: string;
  REDIRECT_URI: string;
}

interface StravaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
  athlete?: Record<string, unknown>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_API_BASE = "https://www.strava.com/api/v3";

// Refresh the token if it expires within this many milliseconds
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

// Default OAuth scopes
const DEFAULT_SCOPE = "read,activity:read_all,profile:read_all";

// ─── CORS headers ─────────────────────────────────────────────────────────────

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(
  body: unknown,
  status = 200,
  extra: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...extra,
    },
  });
}

// ─── Token helpers ────────────────────────────────────────────────────────────

async function loadTokens(env: Env): Promise<StravaTokens | null> {
  const raw = await env.STRAVA_KV.get("strava_tokens");
  if (!raw) return null;
  return JSON.parse(raw) as StravaTokens;
}

async function refreshTokens(env: Env, tokens: StravaTokens): Promise<StravaTokens> {
  const clientSecret = await env.STRAVA_KV.get("STRAVA_CLIENT_SECRET");
  if (!clientSecret) {
    throw new Error("STRAVA_CLIENT_SECRET not found in KV. Add it with: wrangler kv key put --binding STRAVA_KV STRAVA_CLIENT_SECRET <your-secret>");
  }

  // Strava's token endpoint requires application/x-www-form-urlencoded, not JSON
  const resp = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }).toString(),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${detail}`);
  }

  const refreshed = (await resp.json()) as StravaTokens;
  await env.STRAVA_KV.put("strava_tokens", JSON.stringify(refreshed));
  return refreshed;
}

/**
 * Returns a valid access token, refreshing automatically if needed.
 */
async function getValidAccessToken(env: Env): Promise<string> {
  const tokens = await loadTokens(env);
  if (!tokens) {
    throw new Error("No Strava tokens found. Visit /auth to authenticate first.");
  }

  const expiresMs = tokens.expires_at * 1000;
  if (expiresMs < Date.now() + REFRESH_BUFFER_MS) {
    const refreshed = await refreshTokens(env, tokens);
    return refreshed.access_token;
  }

  return tokens.access_token;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

/** GET /auth → redirect to Strava OAuth consent */
function handleAuth(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope") ?? DEFAULT_SCOPE;

  const authUrl = new URL(STRAVA_AUTH_URL);
  authUrl.searchParams.set("client_id", env.STRAVA_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", env.REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("approval_prompt", "auto");

  return Response.redirect(authUrl.toString(), 302);
}

/** GET /callback?code=... → exchange code, store tokens */
async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return jsonResponse({ error: `Strava OAuth error: ${error}` }, 400);
  }
  if (!code) {
    return jsonResponse({ error: "Missing 'code' query parameter" }, 400);
  }

  const clientSecret = await env.STRAVA_KV.get("STRAVA_CLIENT_SECRET");
  if (!clientSecret) {
    return jsonResponse(
      {
        error: "STRAVA_CLIENT_SECRET not configured.",
        fix: "Run: wrangler kv key put --binding STRAVA_KV STRAVA_CLIENT_SECRET <your-secret>",
      },
      500
    );
  }

  // Strava's token endpoint requires application/x-www-form-urlencoded, not JSON
  const tokenResp = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: env.REDIRECT_URI,
    }).toString(),
  });

  if (!tokenResp.ok) {
    const detail = await tokenResp.text();
    return jsonResponse(
      { error: "Token exchange failed", detail },
      tokenResp.status
    );
  }

  const tokens = (await tokenResp.json()) as StravaTokens;

  // Strip the athlete blob before storing to keep KV value lean
  const { athlete, ...tokensToStore } = tokens;
  await env.STRAVA_KV.put("strava_tokens", JSON.stringify(tokensToStore));

  return jsonResponse({
    message: "Authentication successful. Tokens stored in KV.",
    athlete: athlete
      ? `${(athlete as Record<string, string>).firstname} ${(athlete as Record<string, string>).lastname}`
      : undefined,
    expires_at: new Date(tokens.expires_at * 1000).toISOString(),
  });
}

/** ANY /strava/* → proxy to Strava API v3 with auto-refresh */
async function handleStravaProxy(request: Request, env: Env): Promise<Response> {
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(env);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 401);
  }

  const url = new URL(request.url);

  // Strip the /strava prefix to get the Strava API path
  const stravaPath = url.pathname.replace(/^\/strava/, "") || "/";
  const upstreamUrl = new URL(STRAVA_API_BASE + stravaPath);

  // Forward all query parameters
  url.searchParams.forEach((value, key) => {
    upstreamUrl.searchParams.set(key, value);
  });

  // Forward the request body for non-GET methods
  const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase());

  const upstreamResp = await fetch(upstreamUrl.toString(), {
    method: request.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: hasBody ? request.body : undefined,
  });

  const responseBody = await upstreamResp.text();

  return new Response(responseBody, {
    status: upstreamResp.status,
    headers: {
      "Content-Type":
        upstreamResp.headers.get("Content-Type") ?? "application/json",
      ...corsHeaders,
    },
  });
}

// ─── Main fetch handler ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/auth") {
        return handleAuth(request, env);
      }

      if (pathname === "/callback") {
        return handleCallback(request, env);
      }

      if (pathname.startsWith("/strava")) {
        return handleStravaProxy(request, env);
      }

      // Health / index
      if (pathname === "/" || pathname === "/health") {
        return jsonResponse({
          service: "mcm-dashboard strava worker",
          status: "ok",
          routes: {
            "GET /auth": "Redirect to Strava OAuth consent",
            "GET /callback": "OAuth callback — exchange code for tokens",
            "ANY /strava/*": "Proxy to Strava API v3 (auto-refreshes token)",
          },
          strava_client_id: env.STRAVA_CLIENT_ID,
        });
      }

      return jsonResponse(
        {
          error: "Not found",
          available_routes: ["/auth", "/callback", "/strava/*"],
        },
        404
      );
    } catch (err) {
      return jsonResponse(
        { error: "Internal server error", detail: (err as Error).message },
        500
      );
    }
  },
};

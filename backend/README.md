# MCM Dashboard — Strava Worker (Cloudflare)

A Cloudflare Worker that handles **Strava OAuth 2.0** token exchange and proxies authenticated requests to the **Strava API v3** for the MCM Marathon Dashboard.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` or `/health` | Health check + route listing |
| `GET` | `/auth` | Redirect to Strava OAuth consent screen |
| `GET` | `/callback` | OAuth callback — exchanges code for tokens, stores in KV |
| `ANY` | `/strava/*` | Proxy to Strava API v3 (auto-refreshes token) |

### Proxy examples

```
GET /strava/athlete                      → GET https://www.strava.com/api/v3/athlete
GET /strava/athlete/activities?per_page=10 → GET https://www.strava.com/api/v3/athlete/activities?per_page=10
GET /strava/segments/1234                → GET https://www.strava.com/api/v3/segments/1234
```

## Setup

### 1. Install dependencies

```bash
cd backend
npm install
```

### 2. Store your Strava Client Secret in KV

```bash
npm run secret:set -- <your-strava-client-secret>
# Equivalent to:
# wrangler kv key put --binding STRAVA_KV STRAVA_CLIENT_SECRET <secret>
```

> **Never** put the client secret in `wrangler.toml` or commit it to Git.

### 3. Update REDIRECT_URI in wrangler.toml

After your first deploy, update `REDIRECT_URI` in `wrangler.toml` to your worker's URL:

```toml
[vars]
REDIRECT_URI = "https://mcm-strava-worker.<your-subdomain>.workers.dev/callback"
```

Also add this URL to your Strava app's **Authorization Callback Domain** at  
[https://www.strava.com/settings/api](https://www.strava.com/settings/api).

### 4. Deploy

```bash
npm run deploy
```

### 5. Authenticate

Visit `https://mcm-strava-worker.<your-subdomain>.workers.dev/auth` in your browser.  
You'll be redirected to Strava, asked to authorize, then redirected back to `/callback`  
where tokens are stored automatically in KV.

## KV Storage

Namespace: `strava-auth-store` (ID: `e4f95c0b2677460baba8496b95b6b78f`)

| Key | Set by | Value |
|-----|--------|-------|
| `STRAVA_CLIENT_SECRET` | You (step 2) | Your Strava app secret |
| `strava_tokens` | `/callback` handler | `{ access_token, refresh_token, expires_at, ... }` |

## Local development

```bash
npm run dev
# Worker runs on http://localhost:8787
# Auth flow: http://localhost:8787/auth
```

> For local OAuth to work, add `http://localhost:8787/callback` to your Strava app's  
> Authorization Callback Domain.

## Token auto-refresh

The `/strava/*` proxy automatically refreshes the access token when it's within  
5 minutes of expiring. The new tokens are written back to KV transparently.

## Cloudflare resources

- **Account ID:** `daae77a42a12ac81e9b765dd26b3ba32`
- **KV Namespace ID:** `e4f95c0b2677460baba8496b95b6b78f`
- **Worker name:** `mcm-strava-worker`

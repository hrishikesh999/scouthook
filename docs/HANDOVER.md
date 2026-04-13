# ScoutHook — Technical Handover

**Product:** AI-powered LinkedIn content tool  
**Stack:** Node.js + Express, PostgreSQL (Neon), Redis/BullMQ, Anthropic Claude, Google OAuth + LinkedIn OAuth  
**Last updated:** 2026-04-13

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Directory Structure](#directory-structure)
3. [Data Model](#data-model)
4. [HTTP API Reference](#http-api-reference)
5. [Services Reference](#services-reference)
6. [Security Model](#security-model)
7. [LinkedIn Compliance](#linkedin-compliance)
8. [Deployment](#deployment)
9. [Environment Variables](#environment-variables)
10. [Known Limitations](#known-limitations)
11. [Recent Changes (Audit Fixes)](#recent-changes-audit-fixes)

---

## Architecture Overview

ScoutHook is a single-process Node.js server that:

1. Authenticates users via **Google OAuth** (Passport.js, server-side sessions)
2. Allows users to connect a **LinkedIn account** (OAuth, encrypted token storage)
3. Generates LinkedIn posts via **Anthropic Claude** — hook selection, quality gating, format enforcement
4. Publishes posts to LinkedIn immediately or via a **BullMQ/Redis job queue** (scheduled delivery)
5. Syncs engagement metrics back from LinkedIn and enforces a **90-day data retention** policy

```
Browser ──► Express (server.js)
              ├── /auth/*          Google OAuth (Passport)
              ├── /api/profile     Voice/brand settings
              ├── /api/generate    AI post generation (Anthropic)
              ├── /api/linkedin    OAuth connect + publish + schedule + metrics
              ├── /api/media       File upload (images, PDFs)
              ├── /api/visuals     Visual generation (Sharp, pdf-lib)
              ├── /api/stats       Dashboard analytics
              ├── /api/posts       Post CRUD
              ├── /api/recipes     Content recipe templates
              ├── /api/notifications  In-app notification bell
              └── /admin           Settings admin (API keys, platform settings)

BullMQ Worker ──► publishScheduledPost()
                    └── linkedinPublisher.js ──► LinkedIn API
```

**Identity:** All user/tenant identity is derived exclusively from the server-side session (`req.user`). No client headers are trusted for identity.

---

## Directory Structure

```
/
├── server.js                  # Express app entry point
├── db/
│   └── pg.js                  # PostgreSQL adapter (pool, prepare, transaction)
├── db.js                      # Re-exports db adapter + getSettingSync helper
├── config/
│   └── seedData.js            # Initial post formats and recipe seed data
├── routes/
│   ├── linkedin.js            # LinkedIn OAuth + publish + schedule + metrics
│   ├── generate.js            # AI generation pipeline
│   ├── profile.js             # User voice/brand profile
│   ├── recipes.js             # Content recipe templates
│   ├── stats.js               # Dashboard stats + post CRUD
│   ├── events.js              # Client event logging (copy, etc.)
│   ├── media.js               # File upload and management
│   ├── visuals.js             # Visual generation (cards, carousels)
│   ├── notifications.js       # In-app notifications
│   └── admin.js               # Admin settings panel
├── services/
│   ├── linkedinOAuth.js       # Token encrypt/decrypt/store/refresh/revoke
│   ├── linkedinPublisher.js   # Post composition + LinkedIn API calls
│   ├── linkedinMetrics.js     # Metrics sync from LinkedIn API
│   ├── scheduler.js           # BullMQ job queue (init, enqueue, cancel, worker)
│   ├── redis.js               # Shared IORedis client with fallback helpers
│   ├── hookSelector.js        # 8-archetype hook classification
│   ├── qualityGate.js         # Quality scoring + retry enforcement
│   ├── voiceFingerprint.js    # Extract writing voice from profile text
│   └── ...                    # Additional generation services
├── migrations/
│   ├── 001_initial.sql        # Core tables
│   ├── 002_*.sql              # Schema evolution
│   ├── 003_publish_notifications.sql  # Notifications table
│   └── 004_metrics_retention.sql      # Retention index + policy record
├── public/                    # Static frontend assets
│   ├── *.html                 # App pages (auth-gated)
│   ├── css/
│   └── js/
├── uploads/                   # Permanent user file uploads
├── generated/                 # Ephemeral generated visuals (cleaned after 24h)
└── docs/
    └── HANDOVER.md            # This file
```

---

## Data Model

### Core Tables

**`user_profiles`**
```
user_id        TEXT  PK (composite with tenant_id)
tenant_id      TEXT  DEFAULT 'default'
brand_name     TEXT
voice_prompt   TEXT  (extracted voice fingerprint)
target_audience TEXT
logo_url       TEXT
brand_colors   JSONB
created_at     TIMESTAMPTZ
updated_at     TIMESTAMPTZ
```
Row is created on first Google OAuth login (`ON CONFLICT DO NOTHING`).

**`generated_posts`**
```
id             BIGSERIAL PK
user_id        TEXT
tenant_id      TEXT  DEFAULT 'default'
content        TEXT
status         TEXT  (draft | published | scheduled | not_sent)
quality_score  INT
hook_type      TEXT
linkedin_post_id TEXT  (set after successful publish; idempotency guard)
likes          INT   NULLable (cleared after 90 days)
comments       INT   NULLable (cleared after 90 days)
reactions      JSONB NULLable (cleared after 90 days)
last_synced_at TIMESTAMPTZ NULLable
created_at     TIMESTAMPTZ
published_at   TIMESTAMPTZ
```

**`linkedin_tokens`**
```
user_id           TEXT  PK (composite with tenant_id)
tenant_id         TEXT
access_token_enc  TEXT  (AES-256-GCM encrypted)
refresh_token_enc TEXT  NULLable (AES-256-GCM encrypted)
expires_at        TIMESTAMPTZ
linkedin_user_id  TEXT
linkedin_name     TEXT
linkedin_photo    TEXT
updated_at        TIMESTAMPTZ
```
Token is automatically refreshed if within 24h of expiry. A `reconnect_required` notification is created if refresh fails.

**`scheduled_posts`**
```
id             BIGSERIAL PK
post_id        BIGINT FK → generated_posts.id
user_id        TEXT
tenant_id      TEXT
scheduled_for  TIMESTAMPTZ
status         TEXT  (pending | processing | sent | not_sent | cancelled)
bull_job_id    TEXT  (BullMQ job reference)
created_at     TIMESTAMPTZ
```

**`scheduled_post_events`**
```
id             BIGSERIAL PK
scheduled_post_id BIGINT FK → scheduled_posts.id (CASCADE DELETE)
event_type     TEXT  (enqueued | processing | sent | failed | cancelled)
detail         TEXT
created_at     TIMESTAMPTZ
```

**`notifications`**
```
id             BIGSERIAL PK
user_id        TEXT
tenant_id      TEXT
type           TEXT  (publish_succeeded | publish_failed | reconnect_required)
title          TEXT
body           TEXT
ref_id         BIGINT  (optional post/token reference)
ref_type       TEXT
read_at        TIMESTAMPTZ NULLable
created_at     TIMESTAMPTZ
```

**`media_files`**
```
id             BIGSERIAL PK
user_id        TEXT
tenant_id      TEXT
filename       TEXT
original_name  TEXT
mime_type      TEXT
size_bytes     INT
created_at     TIMESTAMPTZ
```

**`recipes`**
```
id             BIGSERIAL PK
category       TEXT
name           TEXT
description    TEXT
questions      JSONB
active         BOOLEAN
sort_order     INT
```

**`platform_settings`**
```
key            TEXT PK
value          TEXT
updated_at     TIMESTAMPTZ
```
Stores: `anthropic_api_key`, `redis_url`, `token_encryption_key`.

---

## HTTP API Reference

All `/api/*` routes require an active session (authenticated via Google OAuth). Non-API routes return HTML redirects; API routes return JSON `{ ok: true, ... }` or `{ ok: false, error: '...' }`.

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/auth/google` | Initiate Google OAuth flow |
| `GET` | `/auth/google/callback` | Google OAuth callback → redirect to `/dashboard.html` |
| `POST` | `/auth/logout` | Destroy session, clear cookie |
| `GET` | `/api/auth/me` | Returns `{ user }` from session (null if unauthenticated) |
| `GET` | `/healthz` | Health check (pings DB) |

### LinkedIn

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/linkedin/status` | Returns `{ connected, linkedin_name, linkedin_photo, expires_at }` |
| `GET` | `/api/linkedin/connect` | Initiate LinkedIn OAuth (redirects to LinkedIn) |
| `GET` | `/api/linkedin/callback` | LinkedIn OAuth callback; stores encrypted tokens |
| `POST` | `/api/linkedin/publish` | Publish post immediately; body: `{ post_id, image_url?, pdf_url? }` |
| `POST` | `/api/linkedin/schedule` | Schedule future publish; body: `{ post_id, scheduled_for, image_url?, pdf_url? }` |
| `GET` | `/api/linkedin/scheduled` | List pending scheduled posts for current user |
| `DELETE` | `/api/linkedin/scheduled/:id` | Cancel a scheduled post by scheduled_post id |
| `POST` | `/api/linkedin/scheduled/pause-by-post` | Cancel schedule by `{ post_id }` |
| `POST` | `/api/linkedin/disconnect` | Revoke + delete LinkedIn token |
| `DELETE` | `/api/linkedin/user-data` | GDPR deletion — revoke token, delete all user data |
| `POST` | `/api/linkedin/sync-metrics` | Fetch engagement metrics for recent published posts |

### Content Generation

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/generate` | Generate post from idea; body: `{ idea, recipe_id?, ... }` |
| `POST` | `/api/generate/regenerate/:postId` | Regenerate existing post |
| `POST` | `/api/quality-check` | Score manually edited post text |

Rate limit: 10 generations/hour per user (Redis sliding window, in-memory fallback).

### Posts

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/posts/recent` | Last 5 generated posts |
| `GET` | `/api/posts/scheduled` | Upcoming scheduled posts |
| `GET` | `/api/posts/:id` | Single post with schedule info |
| `PATCH` | `/api/posts/:id` | Update draft content |
| `DELETE` | `/api/posts/:id` | Delete draft post |
| `POST` | `/api/posts/:id/delete` | Same as DELETE (form-friendly) |
| `GET` | `/api/posts` | All posts; optional `?status=draft\|published` filter |

### Profile

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/profile/:user_id` | Get user voice/brand profile |
| `POST` | `/api/profile` | Save/update profile (triggers async voice fingerprint extraction) |

### Stats & Analytics

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/stats` | Monthly post count, avg quality score, scheduled count |

### Recipes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/recipes` | All active recipes grouped by category |

### Media

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/media` | List uploaded files for current user |
| `POST` | `/api/media/upload` | Upload file (raw binary, 20MB max); `Content-Type` header required |
| `POST` | `/api/media/save-generated` | Copy a generated visual into permanent library |
| `DELETE` | `/api/media/:id` | Delete file from disk and DB |

### Visuals

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/visuals/:postId` | Generate visual; body: `{ type: 'quote_card'\|'carousel'\|'branded_quote' }` |

Generated files are served at `/files/*` (auth-gated, cleaned after 24h). Permanent uploads at `/uploads/*` (auth-gated, never cleaned).

### Notifications

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/notifications` | Unread notifications, limit 50 |
| `POST` | `/api/notifications/read` | Mark one (`{ id }`) or all notifications as read |

### Admin

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin.html` | Admin settings UI (password-protected: `ADMIN_PASSWORD` env var) |
| `GET` | `/admin/settings` | Returns platform settings (sensitive keys masked) |
| `POST` | `/admin/settings` | Update one platform setting (`{ key, value }`) |

---

## Services Reference

### `services/linkedinOAuth.js`
Handles all LinkedIn token lifecycle:
- **`storeTokens(userId, tenantId, tokenData)`** — AES-256-GCM encrypt and upsert into `linkedin_tokens`
- **`getValidAccessToken(userId, tenantId)`** — Returns plaintext token; auto-refreshes if within 24h of expiry; throws `reconnect_required` if refresh fails
- **`refreshLinkedInToken(userId, tenantId, encRefreshToken)`** — Exchanges refresh token with LinkedIn; updates DB
- **`revokeLinkedInToken(userId, tenantId)`** — Calls LinkedIn's `/oauth/v2/revoke` endpoint before token deletion; best-effort (never throws)
- **`encrypt(plaintext)` / `decrypt(encrypted)`** — AES-256-GCM with key from `TOKEN_ENCRYPTION_KEY` env or admin settings

**Critical:** `token_encryption_key` must be a 64-char hex string (32 bytes). Set once and never rotate — rotating will orphan all stored tokens.

### `services/linkedinPublisher.js`
Composes and submits posts to LinkedIn's Posts API:
- Supports text-only, single image, and PDF carousel post types
- Uses API version `202501` with `X-Restli-Protocol-Version: 2.0.0`
- **Idempotency guard:** checks `row.linkedin_post_id` before calling API to prevent duplicate posts on BullMQ retry
- **`NON_RETRIABLE_ERRORS`** set: errors that permanently mark a post `not_sent` without retry (includes `reconnect_required`, `rate_limit_exceeded`, `invalid_image_url`, etc.)
- On success: sets `status='published'`, `linkedin_post_id`, `published_at`, and inserts `publish_succeeded` notification
- On retriable failure: resets to `status='pending'`, throws (BullMQ retries up to 3 times with exponential backoff)
- On non-retriable failure: sets `status='not_sent'`, inserts `publish_failed` notification, does not throw

### `services/scheduler.js`
BullMQ-based job queue for scheduled publishing:
- **`initScheduler()`** — Connects to Redis, creates queue + worker, re-enqueues any `pending` scheduled posts on startup
- **`addScheduledJob(scheduledPostId, scheduledDate)`** — Enqueues delayed BullMQ job (job ID: `spost-{id}`)
- **`removeScheduledJob(scheduledPostId)`** — Cancels pending job
- **`getWorker()`** — Returns BullMQ Worker instance (used for graceful shutdown)
- Job config: 3 attempts, exponential backoff (1min → 2min → 4min delays), `removeOnFail: false`
- **Disabled silently if `REDIS_URL` not configured** — posts save to DB but never auto-publish

### `services/redis.js`
Shared IORedis client with clean fallback:
- **`initRedis()`** — Lazy-initializes from `REDIS_URL` env or admin settings
- **`getRedis()`** — Returns client or `null`
- **`redisSet(key, value, ttlSeconds)`** — JSON.stringify + SET EX; returns `false` if Redis unavailable
- **`redisGet(key)`** — JSON.parse; returns `null` if unavailable
- **`redisDel(key)`** — Best-effort delete
- Used for: OAuth state CSRF tokens, AI generation rate limiting, scheduled post OAuth state

### `services/linkedinMetrics.js`
Syncs post engagement from LinkedIn's Analytics API:
- Uses API version `202501`
- All UPDATE queries scoped by `user_id` and `tenant_id`
- Called manually via `POST /api/linkedin/sync-metrics`

### `services/hookSelector.js`
Classifies a post idea into one of 8 hook archetypes:
`contrarian`, `story`, `how_to`, `listicle`, `stat`, `question`, `prediction`, `confession`

### `services/qualityGate.js`
Scores generated posts and enforces quality thresholds. Retries generation if quality is below threshold.

---

## Security Model

### Identity
- User and tenant identity come **exclusively from the server-side session** — never from request headers or query parameters
- `req.userId` and `req.tenantId` are set from `req.user` (Passport session) in middleware after auth
- Attempting to spoof identity via `x-user-id` or `x-tenant-id` headers has no effect

### Session
- `httpOnly`, `sameSite: 'lax'`, `secure` in production
- 14-day expiry
- Cookie name: `scouthook.sid`

### LinkedIn Tokens
- Stored as AES-256-GCM encrypted blobs in Postgres — never in plaintext
- Decryption key is server-side only (`TOKEN_ENCRYPTION_KEY` env var or admin settings)
- Auto-refreshed 24h before expiry
- Revoked on LinkedIn's auth server before deletion (on disconnect and GDPR delete)

### CSRF
- OAuth state parameter for LinkedIn is stored in Redis (or in-memory fallback); validated on callback to prevent CSRF attacks

### File Serving
- `/files/*` (generated visuals) and `/uploads/*` (media library) require an active session
- Path traversal is explicitly prevented in `serveAuthenticatedFile()`

### Rate Limiting
- `/api/*`: 2000 req/15min per user (session-keyed), falls back to IP
- AI generation: 10/hour per user (Redis sliding window, in-memory fallback)
- LinkedIn publishing: enforced by LinkedIn API (1 post/hour for most apps)

### Admin
- `/admin.html` and `/admin/*` routes are password-protected via `ADMIN_PASSWORD` env var
- Sensitive keys are masked in GET responses

---

## LinkedIn Compliance

ScoutHook uses the following LinkedIn OAuth scopes:
- `openid`, `profile` — identity (name, photo)
- `w_member_social` — publish posts on user's behalf

**Compliance measures implemented:**
1. **Scope minimization** — `email` scope removed; only what's needed is requested
2. **Explicit consent page** — `/connect-linkedin.html` shows exactly what will/won't be done before OAuth flow begins
3. **Token revocation** — LinkedIn tokens are revoked via `POST /oauth/v2/revoke` on disconnect and GDPR delete
4. **GDPR data deletion** — `DELETE /api/linkedin/user-data` cascades deletion across all user tables
5. **Engagement data retention** — LinkedIn engagement metrics nulled out after 90 days (LinkedIn ToS data minimisation)
6. **API versioning** — All calls use `LinkedIn-Version: 202501` and `X-Restli-Protocol-Version: 2.0.0`
7. **No unsolicited posting** — Publishing requires explicit user action (click Publish or confirm a scheduled time)
8. **No feed/message reading** — `w_member_social` only; no read scopes

---

## Deployment

### Render (recommended)

1. Connect GitHub repo in Render dashboard
2. Set all required env vars (see table below)
3. Add a Redis instance (Render Redis or Upstash); set `REDIS_URL`
4. Add `npm run migrate` as a pre-deploy command (or run via Render shell on first deploy)
5. Set `NODE_ENV=production` and a strong random `SESSION_SECRET`
6. Set `token_encryption_key` via admin UI at `/admin.html` — generate once with `openssl rand -hex 32`

### Health check
`GET /healthz` — returns `200 { ok: true }` when DB is reachable; used by Render's health check configuration.

### Graceful shutdown
On `SIGTERM` (Render deploy): HTTP server drains in-flight requests, BullMQ worker closes, Redis client disconnects cleanly.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | Neon/Postgres connection string |
| `SESSION_SECRET` | ✅ | Express session secret (strong random string) |
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google OAuth client secret |
| `GOOGLE_CALLBACK_URL` | ✅ | e.g. `https://yourapp.com/auth/google/callback` |
| `LINKEDIN_CLIENT_ID` | ✅ | LinkedIn OAuth client ID |
| `LINKEDIN_CLIENT_SECRET` | ✅ | LinkedIn OAuth client secret |
| `ANTHROPIC_API_KEY` | ✅* | *Can be set via admin UI instead |
| `REDIS_URL` | ⬜ | Required for scheduled post delivery |
| `TOKEN_ENCRYPTION_KEY` | ⬜ | 64-char hex AES key; can be set via admin UI. **Set once, never rotate.** |
| `ADMIN_PASSWORD` | ⬜ | Admin panel password (default: `changeme`) |
| `PORT` | ⬜ | HTTP port (default: `4000`) |
| `NODE_ENV` | ⬜ | Set to `production` for secure cookies |
| `ALLOWED_ORIGIN` | ⬜ | CORS allowed origin for cross-domain setups |
| `API_RATE_LIMIT_MAX` | ⬜ | Override default 2000 req/15min API rate limit |

### Admin UI settings (`/admin.html`)

| Key | Description |
|-----|-------------|
| `anthropic_api_key` | Anthropic API key (overrides env var) |
| `redis_url` | Redis connection string (overrides env var) |
| `token_encryption_key` | AES-256-GCM key for LinkedIn token encryption |

---

## Known Limitations

### Architecture
- **Single-process:** BullMQ worker runs in the same process as the HTTP server. Under high load, consider splitting into a dedicated worker process.
- **Local file storage:** Uploads and generated visuals are stored on local disk — not compatible with multi-instance horizontal scaling. Move to S3/R2/Cloudflare for multi-replica deployments.
- **Single tenant in practice:** Multi-tenancy scaffolding (user_id + tenant_id on all tables) is in place, but the `tenant_id` is hardcoded to `'default'` for all users. A tenant provisioning layer would be needed to support true multi-tenant SaaS.

### Security
- **`token_encryption_key` is permanent:** There is no key rotation mechanism. Rotating the key orphans all stored LinkedIn tokens (users would need to reconnect).
- **No PKCE on LinkedIn OAuth:** The OAuth flow uses `state` parameter for CSRF protection but not PKCE. Consider adding PKCE for additional OAuth code interception protection.

### Scheduling
- **Requires Redis:** Without `REDIS_URL`, posts save but never auto-publish. There is no polling fallback.
- **No job persistence across Redis flushes:** If Redis is flushed, pending jobs are lost (though the DB records remain; they'll be re-enqueued on next server restart via the startup recovery loop).

### Metrics
- **Manual sync only:** Engagement metrics must be fetched explicitly via `POST /api/linkedin/sync-metrics`. There is no automatic background polling for metrics.
- **90-day retention:** LinkedIn engagement data (likes, comments, reactions) is nulled after 90 days per LinkedIn ToS. The post content and status are retained indefinitely.

---

## Recent Changes (Audit Fixes)

These changes were applied during a security and compliance audit in April 2026.

| Issue | Fix Applied |
|-------|-------------|
| Identity headers trusted for user/tenant | All identity now session-derived only; `x-user-id`/`x-tenant-id` headers ignored |
| Rate limiter keyed by untrusted header | `keyGenerator` now uses `req.userId` from session |
| Cross-tenant data access in queries | All UPDATE/SELECT queries in linkedin.js, linkedinPublisher.js, linkedinMetrics.js now scope by `user_id` AND `tenant_id` |
| OAuth state stored in session (single-server only) | Moved to Redis with in-memory fallback |
| LinkedIn `email` scope included unnecessarily | Removed; scopes now: `openid profile w_member_social` |
| No token revocation on disconnect/GDPR delete | `revokeLinkedInToken()` added; called before row deletion |
| Token revocation ordering in GDPR delete | `revokeLinkedInToken()` called before the transaction (transaction deletes the row) |
| Duplicate post risk on BullMQ retry | Idempotency guard checks `linkedin_post_id` before calling API |
| No retry / all failures permanent | 3-attempt exponential backoff (1→2→4 min); `NON_RETRIABLE_ERRORS` set for permanent failures |
| No reconnect notification on token expiry | `createReconnectNotification()` fires on token refresh failure |
| Generated files served without auth | `serveAuthenticatedFile()` replaces open `express.static()` for `/files` and `/uploads` |
| No engagement data retention policy | 90-day cleanup job; `migrations/004_metrics_retention.sql` records policy |
| LinkedIn API version drift | All calls standardised on `202501` |
| No graceful shutdown | SIGTERM/SIGINT handlers drain HTTP server, BullMQ worker, Redis client |
| No in-app notifications | `notifications` table + `routes/notifications.js` added |
| Redis client not shared | `services/redis.js` added as shared client with fallback helpers |

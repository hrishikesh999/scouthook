# ScoutHook — Technical Handover

**Product:** AI-powered LinkedIn content intelligence platform  
**Stack:** Node.js + Express, PostgreSQL (Neon), Redis/BullMQ, Anthropic Claude, Google OAuth + LinkedIn OAuth  
**Last updated:** 2026-05-06 (Sprint 1 — Hook injection, Performance Tagging, Viral tension pre-check)

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
11. [Recent Changes](#recent-changes)

---

## Architecture Overview

ScoutHook is a single-process Node.js server that:

1. Authenticates users via **Google OAuth** (Passport.js, server-side sessions)
2. Allows users to connect a **LinkedIn account** (OAuth, encrypted token storage)
3. Powers an **Intelligence Vault** — users upload PDFs/DOCX/URLs → documents are chunked and indexed → Claude Sonnet mines "seed ideas" (frameworks, case studies, contrarian views) on demand
4. Classifies every seed and every generated post into a **funnel type** (reach / trust / convert) via Claude Haiku, and tracks funnel health across the last 30 days
5. Generates LinkedIn posts via **Anthropic Claude** — from a free-typed idea (Tab A) or a Vault seed (Tab B), with hook selection, quality gating, and format enforcement
6. Publishes posts to LinkedIn immediately or via a **BullMQ/Redis job queue** (scheduled delivery)
7. Stores user uploads and generated visuals on **Amazon S3** (or local disk in dev)
8. Syncs engagement metrics back from LinkedIn and enforces a **90-day data retention** policy

```
Browser ──► Express (server.js)
              ├── /auth/*            Google OAuth (Passport)
              ├── /api/profile       Voice/brand settings
              ├── /api/generate      AI post generation (Anthropic Sonnet)
              ├── /api/vault         Document upload, indexing, mining, ideas
              ├── /api/funnel        Funnel health aggregates
              ├── /api/linkedin      OAuth connect + publish + schedule + metrics
              ├── /api/media         File upload (images, PDFs)
              ├── /api/visuals       Visual generation (Sharp, pdf-lib)
              ├── /api/stats         Dashboard analytics
              ├── /api/posts         Post CRUD
              ├── /api/recipes       Content recipe templates
              ├── /api/notifications In-app notification bell
              └── /admin             Settings admin (API keys, platform settings)

BullMQ Worker ──► publishScheduledPost()
                    └── linkedinPublisher.js ──► LinkedIn API

Vault async background (setImmediate):
  upload → extractAndChunk() → saveChunks() → document.status = 'ready'
  mine   → mineChunks()      → classifyContent() per seed → vault_ideas rows
```

**Identity:** All user/tenant identity is derived exclusively from the server-side session (`req.user`). No client headers are trusted for identity.

---

## Directory Structure

```
/
├── server.js                    # Express app entry point
├── db/
│   └── pg.js                    # PostgreSQL adapter (pool, prepare, transaction)
├── db.js                        # Re-exports db adapter + getSettingSync helper
├── config/
│   └── seedData.js              # Initial post formats and recipe seed data
├── routes/
│   ├── linkedin.js              # LinkedIn OAuth + publish + schedule + metrics
│   ├── generate.js              # AI generation pipeline (+ vault_idea_id support)
│   ├── vault.js                 # Intelligence Vault: upload, index, mine, ideas
│   ├── funnel.js                # Funnel health aggregates
│   ├── profile.js               # User voice/brand profile
│   ├── recipes.js               # Content recipe templates
│   ├── stats.js                 # Dashboard stats + post CRUD
│   ├── performance.js           # Post performance tagging (🔥/👍/👎) + Content Intelligence summary
│   ├── events.js                # Client event logging (copy, etc.)
│   ├── media.js                 # File upload and management
│   ├── visuals.js               # Visual generation (cards, carousels)
│   ├── notifications.js         # In-app notifications
│   └── admin.js                 # Admin settings panel
├── services/
│   ├── storage.js               # Storage abstraction (local disk or Amazon S3)
│   ├── vaultMiner.js            # Document extraction, chunking, Claude Sonnet mining
│   ├── funnelClassifier.js      # Claude Haiku: funnel_type + hook_archetype per seed/post
│   ├── linkedinOAuth.js         # Token encrypt/decrypt/store/refresh/revoke
│   ├── linkedinPublisher.js     # Post composition + LinkedIn API calls
│   ├── linkedinMetrics.js       # Metrics sync from LinkedIn API
│   ├── scheduler.js             # BullMQ job queue (init, enqueue, cancel, worker)
│   ├── redis.js                 # Shared IORedis client with fallback helpers
│   ├── hookSelector.js          # 8-archetype hook classification
│   ├── qualityGate.js           # Quality scoring + retry enforcement
│   ├── ideaPath.js              # Core generation flow (+ _funnelHint support)
│   └── voiceFingerprint.js      # Extract writing voice from profile text
├── migrations/
│   ├── 001_initial.sql          # Core tables
│   ├── 002_scheduled_post_events_cascade.sql
│   ├── 003_publish_notifications.sql
│   ├── 004_metrics_retention.sql
│   └── 005_vault.sql            # Vault tables + funnel columns on generated_posts
├── public/                      # Static frontend assets
│   ├── vault.html               # Intelligence Vault page
│   ├── ideas.html               # Ideas kanban (Fresh / Saved / Discarded)
│   ├── generate.html            # Post generation (Tab A: write / Tab B: vault)
│   ├── *.html                   # Other app pages (auth-gated)
│   ├── css/
│   └── js/
├── uploads/                     # Permanent user file uploads (local mode only)
├── generated/                   # Ephemeral generated visuals (local mode only)
└── docs/
    └── HANDOVER.md              # This file
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
id                    BIGSERIAL PK
user_id               TEXT
tenant_id             TEXT  DEFAULT 'default'
content               TEXT
status                TEXT  (draft | published | scheduled | not_sent)
quality_score         INT
hook_type             TEXT
funnel_type           TEXT  (reach | trust | convert)         ← migration 005
vault_source_ref      TEXT  (e.g. "Q3 Strategy PDF · p.4")   ← migration 005
archetype_used        TEXT  (e.g. MYTH_BUST, INSIGHT, etc.)  ← migration 018
linkedin_post_id      TEXT  (set after publish; idempotency guard)
likes                 INT   NULLable (cleared after 90 days)
comments              INT   NULLable (cleared after 90 days)
reactions             JSONB NULLable (cleared after 90 days)
last_synced_at        TIMESTAMPTZ NULLable
created_at            TIMESTAMPTZ
published_at          TIMESTAMPTZ
performance_tag       TEXT  NULLable  (strong | decent | weak) ← migration 018
performance_note      TEXT  NULLable                           ← migration 018
performance_tagged_at TIMESTAMPTZ NULLable                     ← migration 018
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
id                BIGSERIAL PK
scheduled_post_id BIGINT FK → scheduled_posts.id (CASCADE DELETE)
event_type        TEXT  (enqueued | processing | sent | failed | cancelled)
detail            TEXT
created_at        TIMESTAMPTZ
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

### Vault Tables (migration 005)

**`vault_documents`**
```
id             BIGSERIAL PK
user_id        TEXT
tenant_id      TEXT  DEFAULT 'default'
filename       TEXT
source_type    TEXT  (pdf | docx | txt | url)
source_url     TEXT  NULLable
storage_key    TEXT  NULLable  (key in storage.js for file uploads)
status         TEXT  DEFAULT 'pending'  (pending | indexing | ready | error)
chunk_count    INT   DEFAULT 0
ideas_mined    INT   DEFAULT 0
error_message  TEXT  NULLable
created_at     TIMESTAMPTZ
updated_at     TIMESTAMPTZ
```
Index: `(user_id, tenant_id)`

**`vault_chunks`**
```
id             BIGSERIAL PK
document_id    BIGINT FK → vault_documents.id (CASCADE DELETE)
user_id        TEXT
tenant_id      TEXT  DEFAULT 'default'
chunk_index    INT
content        TEXT
source_ref     TEXT  NULLable  (e.g. "Page 4")
mined_at       TIMESTAMPTZ NULLable  (NULL = not yet mined)
```
Indexes: `(document_id)`, partial `(document_id) WHERE mined_at IS NULL`

**`vault_ideas`**
```
id                  BIGSERIAL PK
user_id             TEXT
tenant_id           TEXT  DEFAULT 'default'
document_id         BIGINT FK → vault_documents.id (CASCADE DELETE)
chunk_id            BIGINT FK → vault_chunks.id    (SET NULL on delete)
seed_text           TEXT
source_ref          TEXT  NULLable  (e.g. "From: Q3 Strategy PDF · p.4")
funnel_type         TEXT  NULLable  (reach | trust | convert)
hook_archetype      TEXT  NULLable
status              TEXT  DEFAULT 'fresh'  (fresh | saved | discarded | used)
generated_post_id   BIGINT FK → generated_posts.id (SET NULL on delete)
created_at          TIMESTAMPTZ
```
Index: `(user_id, tenant_id, status)`

**Seed lifecycle:**
- `fresh` → surfaced in Tab B and Ideas page Fresh column
- `saved` → bookmarked; appears in both Tab B and Ideas page Saved column
- `discarded` → hidden from Tab B; visible in Ideas page Discarded column
- `used` → a post was grown from this seed; shows "Draft created" / "Published" label
- If the linked `generated_post_id` post is deleted: `status` resets to `'fresh'`, `generated_post_id` → NULL

---

## HTTP API Reference

All `/api/*` routes require an active session. API routes return JSON `{ ok: true, ... }` or `{ ok: false, error: '...' }`.

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/auth/google` | Initiate Google OAuth flow |
| `GET` | `/auth/google/callback` | Google OAuth callback → redirect to `/dashboard.html` |
| `POST` | `/auth/logout` | Destroy session, clear cookie |
| `GET` | `/api/auth/me` | Returns `{ user }` from session (null if unauthenticated) |
| `GET` | `/healthz` | Health check (pings DB) |

### Intelligence Vault

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/vault/upload` | Upload file (raw binary) or URL (JSON `{ url }`). Creates `vault_documents` record; indexes asynchronously via `setImmediate`. |
| `GET` | `/api/vault/documents` | List user's documents, ordered by `created_at DESC`. Returns `id, filename, source_type, status, chunk_count, ideas_mined, created_at`. |
| `DELETE` | `/api/vault/documents/:id` | Remove document + file from storage; cascades to chunks and ideas. |
| `POST` | `/api/vault/mine` | Trigger mining on all `ready` documents with unmined chunks. Returns immediately `{ ok, chunks_queued }`. Mining runs async; each seed is classified by `funnelClassifier`. |
| `GET` | `/api/vault/ideas` | List ideas. Query params: `status` (default `fresh,saved`), `funnel_type`. Ordered convert → trust → reach. |
| `PATCH` | `/api/vault/ideas/:id` | Update idea status. Body: `{ status: 'fresh'\|'saved'\|'discarded' }`. |

### Funnel Intelligence

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/funnel/health` | Aggregates 30-day `funnel_type` counts from `generated_posts`. Returns `{ counts, total, actual, target, nextSuggested, suggestedRecipe }`. |

**`/api/funnel/health` response shape:**
```json
{
  "ok": true,
  "counts": { "reach": 8, "trust": 1, "convert": 0 },
  "total": 9,
  "actual": { "reach": 89, "trust": 11, "convert": 0 },
  "target": { "reach": 70, "trust": 20, "convert": 10 },
  "nextSuggested": "convert",
  "suggestedRecipe": "Client Conversation"
}
```

### Content Generation

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/generate` | Generate post from idea. Body: `{ path: 'idea', raw_idea, vault_idea_id?, skip_substance_check? }`. Returns HTTP 422 `{ error: 'missing_substance', prompt }` when input lacks both specificity and tension (bypass with `skip_substance_check: true`). Persists `archetype_used` on the generated post. |
| `POST` | `/api/generate/from-doc` | Generate from uploaded file or URL. Accepts `skip_substance_check` in JSON body. Same 422 behaviour. |
| `POST` | `/api/generate/regenerate/:postId` | Regenerate existing post; persists updated `archetype_used` |
| `POST` | `/api/quality-check` | Score manually edited post text |

Rate limit: 10 generations/hour per user (Redis sliding window, in-memory fallback).

### Posts

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/posts/recent` | Last 5 generated posts (includes `archetype_used`, `published_at`, `performance_tag`) |
| `GET` | `/api/posts/scheduled` | Upcoming scheduled posts |
| `GET` | `/api/posts/:id` | Single post with schedule info |
| `PATCH` | `/api/posts/:id` | Update draft content |
| `DELETE` | `/api/posts/:id` | Delete draft post |
| `POST` | `/api/posts/:id/delete` | Same as DELETE (form-friendly) |
| `GET` | `/api/posts` | All posts; optional `?status=draft\|published` filter |
| `POST` | `/api/posts/:postId/performance` | Tag a published post. Body: `{ tag: 'strong'\|'decent'\|'weak', note?: string }` |
| `GET` | `/api/posts/performance-summary` | Content Intelligence summary: best archetype, best day, untagged posts. Returns `{ enough_data, total_tagged, archetypes, best_day, untagged }`. Requires ≥3 tagged posts for `enough_data: true`. |
| `GET` | `/api/posts/untagged-published` | Published posts without a performance tag (up to 5) |

### Profile

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/profile/:user_id` | Get user voice/brand profile |
| `POST` | `/api/profile` | Save/update profile (triggers async voice fingerprint extraction) |

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

Generated files served at `/files/*` (auth-gated, cleaned after 24h). Permanent uploads at `/uploads/*` (auth-gated, never cleaned). In S3 mode both are streamed from S3 via `storage.stream()`.

### Notifications

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/notifications` | Unread notifications, limit 50 |
| `POST` | `/api/notifications/read` | Mark one (`{ id }`) or all notifications as read |

### Admin

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin.html` | Admin settings UI (password-protected via `ADMIN_PASSWORD`) |
| `GET` | `/admin/settings` | Returns platform settings (sensitive keys masked) |
| `POST` | `/admin/settings` | Update one platform setting (`{ key, value }`) |

---

## Services Reference

### `services/vaultMiner.js` *(new)*

Core document processing and mining service.

- **`extractAndChunk(buffer, sourceType, filename)`** — Extracts text from a `Buffer`. Dispatches to `pdf-parse` (PDF), `mammoth` (DOCX), or plain text. Returns `[{ content, source_ref, chunk_index }]` chunks of ~500 words with 50-word overlap.
- **`extractAndChunkUrl(url)`** — Fetches URL via Node's built-in `https`/`http`, strips HTML tags, and returns chunks.
- **`chunkText(text, totalPages)`** — Low-level chunker; assigns page-based `source_ref` ("Page N") proportionally.
- **`mineChunks(chunks, documentFilename)`** — Batches chunks in groups of 5, calls Claude Sonnet with a mining prompt, extracts structured JSON seeds. Mining prompt instructs Claude to surface contrarian views, proprietary frameworks, case studies, and hard-won lessons — not generic advice. Returns `[{ chunkId, seed_text, source_ref }]`.
- Uses `extractJsonFromResponse` from `voiceFingerprint.js` for robust JSON extraction from Claude responses.

### `services/funnelClassifier.js` *(new)*

Single-call Claude Haiku classifier — mirrors `hookSelector.js` pattern.

- **`classifyContent(text)`** — Returns `{ funnelType, hookArchetype, confidence }`.
  - `funnelType`: `'reach'` | `'trust'` | `'convert'`
  - `hookArchetype`: one of 8 archetypes from `hookArchetypes.js` (`NUMBER`, `CONTRARIAN`, `CONFESSION`, `PATTERN_INTERRUPT`, `DIRECT_ADDRESS`, `STAKES`, `BEFORE_AFTER`, `INSIGHT`)
  - `confidence`: `0.0–1.0`
- Never throws — safe default is `{ funnelType: 'reach', hookArchetype: 'INSIGHT', confidence: 0.5 }`.
- Called during vault mining (per seed) and after the quality gate in `routes/generate.js` (per generated post).

### `services/storage.js`

Abstraction over local disk and Amazon S3.

- **`getBackend()`** — Returns `'local'` or `'s3'` based on `STORAGE_BACKEND` env var.
- **`buildKey(tenantId, userId, type, filename)`** — Constructs storage key: `{S3_KEY_PREFIX}tenants/{tenant_id}/users/{user_id}/{type}/{filename}`. `type` is `uploads` (permanent), `generated` (ephemeral), or `vault` (vault source files).
- **`upload(buffer, { tenantId, userId, type, filename, mimeType })`** — Writes to S3 or local disk.
- **`download(key)`** — Returns a `Buffer` from S3 or local disk.
- **`delete(key)`** — Removes from S3 or local disk (non-throwing).
- **`copy(srcKey, dstKey)`** — Server-side S3 copy or `fs.copyFileSync`.
- **`stream(key, res, next)`** — Pipes object directly to HTTP response.

### `services/linkedinOAuth.js`

- **`storeTokens`**, **`getValidAccessToken`**, **`refreshLinkedInToken`**, **`revokeLinkedInToken`**, **`encrypt`**, **`decrypt`**
- AES-256-GCM encryption; `token_encryption_key` must be 64-char hex. Set once, never rotate.

### `services/linkedinPublisher.js`

Composes and submits posts to LinkedIn's Posts API (API version `202501`):
- Supports text-only, single image, and PDF carousel.
- Idempotency guard checks `row.linkedin_post_id` before calling API.
- `NON_RETRIABLE_ERRORS` set for permanent failures.
- On success: `status='published'`, sets `linkedin_post_id`, `published_at`, inserts `publish_succeeded` notification.
- On retriable failure: resets to `status='pending'`, throws (BullMQ retries ×3 with exponential backoff).
- On non-retriable failure: `status='not_sent'`, inserts `publish_failed` notification.

### `services/scheduler.js`

- BullMQ queue + worker for scheduled publishing.
- Re-enqueues any `pending` scheduled posts on startup (crash recovery).
- 3 attempts, exponential backoff (1 min → 2 min → 4 min).
- **Silent no-op if `REDIS_URL` is not configured.**

### `services/redis.js`

- Shared IORedis client with clean fallback.
- `redisSet`, `redisGet`, `redisDel` helpers return safe defaults when Redis is unavailable.
- Used for: OAuth CSRF state tokens, AI generation rate limiting.

### `services/hookSelector.js`

Classifies a post idea into one of 8 hook archetypes:
`contrarian`, `story`, `how_to`, `listicle`, `stat`, `question`, `prediction`, `confession`

### `services/qualityGate.js`

Scores generated posts and enforces quality thresholds. Retries generation if below threshold.

### `services/ideaPath.js` *(modified)*

Core generation flow. Key functions:

- **`ideaToPost(rawIdea, userProfile, options)`** — Idea path. Runs `selectHook()` + `assessInputQuality()` in parallel before generation. Throws `{ message: 'missing_substance', substancePrompt }` when input has neither a specific outcome nor a surprising angle, unless `options.skipSubstanceCheck` is set.
- **`restructureToPost(sourceText, userProfile, documentContext, options)`** — Editorial path for vault seeds and regeneration. Same `selectHook()` + `assessInputQuality()` parallel pre-check. `buildRefineSystemPrompt()` accepts an optional `hookInjection` block that replaces the generic Rule 1 with the classified archetype's structural pattern. Returns `archetypeUsed` (real archetype key, not `'EDITORIAL'`).
- **`buildSubstancePrompt({ hasSpecific, hasTension })`** — Returns a blocking message string when both are false; null otherwise.
- **`assessInputQuality(text, client)`** — Claude Haiku call; checks for concrete specifics and genuine tension. Fails open (`{ hasSpecific: true, hasTension: true }`) to never block on error.

---

## Frontend Pages

| Page | Route | Description |
|------|-------|-------------|
| `dashboard.html` | `/dashboard.html` | Stats, recent posts, scheduled posts |
| `generate.html` | `/generate.html` | Post generation. Left panel has Tab A ("Write an idea") and Tab B ("From your Vault"). Tab B loads vault seeds with funnel filter; "Use this idea" pre-fills Tab A and passes `vault_idea_id` to the generate API. Source badge shown below the generated post. |
| `vault.html` | `/vault.html` | Upload docs (drag-and-drop PDF/DOCX/TXT) or paste a URL. Document list shows live status badges. "Generate Ideas" button triggers `POST /api/vault/mine` and returns immediately; status polling updates badges. |
| `ideas.html` | `/ideas.html` | Seed bank kanban: Fresh / Saved / Discarded columns. Funnel health widget at top. "Grow this idea" navigates to `/generate.html?vault_idea_id=X&seed=...`. |
| `profile.html` | `/profile.html` | Voice and brand settings |
| `connect-linkedin.html` | `/connect-linkedin.html` | LinkedIn OAuth consent page |

**URL param handoff (ideas.html → generate.html):**
An IIFE in `public/js/generate.js` reads `?vault_idea_id` and `?seed` on page load, pre-fills the Tab A textarea, sets `currentVaultIdeaId`, switches to Tab A, then cleans the URL with `history.replaceState`.

---

## Security Model

### Identity
- User and tenant identity come **exclusively from the server-side session** — never from request headers or query parameters.
- `req.userId` and `req.tenantId` are set from `req.user` (Passport session) in middleware after auth.

### Session
- `httpOnly`, `sameSite: 'lax'`, `secure` in production.
- 14-day expiry. Cookie name: `scouthook.sid`.

### LinkedIn Tokens
- AES-256-GCM encrypted blobs in Postgres — never in plaintext.
- Auto-refreshed 24h before expiry; revoked on LinkedIn's server before deletion.

### CSRF
- OAuth state parameter for LinkedIn is stored in Redis (in-memory fallback); validated on callback.

### File Serving
- `/files/*` and `/uploads/*` require an active session.
- Path traversal explicitly prevented in `serveAuthenticatedFile()`.

### Rate Limiting
- `/api/*`: 2000 req/15min per user (session-keyed).
- AI generation: 10/hour per user (Redis sliding window, in-memory fallback).

### Admin
- `/admin.html` and `/admin/*` password-protected via `ADMIN_PASSWORD` env var.
- Sensitive keys masked in GET responses.

---

## LinkedIn Compliance

Scopes: `openid`, `profile`, `w_member_social` (minimum required).

Compliance measures:
1. **Scope minimisation** — `email` scope removed.
2. **Explicit consent page** — `/connect-linkedin.html` before OAuth flow.
3. **Token revocation** — called via `/oauth/v2/revoke` on disconnect and GDPR delete.
4. **GDPR data deletion** — `DELETE /api/linkedin/user-data` cascades across all user tables.
5. **Engagement data retention** — LinkedIn metrics nulled after 90 days.
6. **API versioning** — all calls use `LinkedIn-Version: 202501` + `X-Restli-Protocol-Version: 2.0.0`.
7. **No unsolicited posting** — requires explicit user action.
8. **No feed/message reading** — `w_member_social` write-only.

---

## Deployment

### Render (recommended)

1. Connect GitHub repo in Render dashboard.
2. Set all required env vars.
3. Add Redis (Render Redis or Upstash); set `REDIS_URL`.
4. Add `npm run migrate` as a pre-deploy command (or run once via Render shell).
5. Set `NODE_ENV=production` and a strong `SESSION_SECRET`.
6. Set `token_encryption_key` via `/admin.html` — generate: `openssl rand -hex 32`. **Set once, never change.**
7. Set `STORAGE_BACKEND=s3`, bucket env vars. See S3 setup below.

### First deploy after Intelligence Vault sprint

Run the vault migration against your live database:
```bash
DATABASE_URL=<prod_url> node scripts/migrate.js
```
This applies `migrations/005_vault.sql`, which:
- Adds `funnel_type` and `vault_source_ref` columns to `generated_posts`
- Creates `vault_documents`, `vault_chunks`, `vault_ideas` tables

### Health check
`GET /healthz` — returns `200 { ok: true }` when DB is reachable.

### Graceful shutdown
On `SIGTERM`: HTTP server drains in-flight requests, BullMQ worker closes, Redis client disconnects.

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
| `STORAGE_BACKEND` | ⬜ | `local` (default) or `s3` |
| `S3_BUCKET_NAME` | ⬜* | Required when `STORAGE_BACKEND=s3`. Dev: `scout-hook-dev`, Prod: `scout-hook-prod` |
| `S3_REGION` | ⬜* | AWS region, e.g. `us-east-1` |
| `AWS_ACCESS_KEY_ID` | ⬜* | IAM access key |
| `AWS_SECRET_ACCESS_KEY` | ⬜* | IAM secret key |
| `S3_KEY_PREFIX` | ⬜ | Optional key prefix, e.g. `dev/` for env isolation within a bucket |
| `S3_ENDPOINT` | ⬜ | Custom S3-compatible endpoint (MinIO, LocalStack) |

> ✅ = required &nbsp;·&nbsp; ⬜ = optional &nbsp;·&nbsp; ⬜* = optional unless `STORAGE_BACKEND=s3`

### S3 Bucket Configuration

| Environment | Bucket | ARN |
|---|---|---|
| Development | `scout-hook-dev` | `arn:aws:s3:::scout-hook-dev` |
| Production | `scout-hook-prod` | `arn:aws:s3:::scout-hook-prod` |

**One-time bucket setup (per environment):**

1. Block all public access: **ON**
2. Attach IAM policy:
   ```json
   {
     "Effect": "Allow",
     "Action": ["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:CopyObject"],
     "Resource": "arn:aws:s3:::scout-hook-{dev|prod}/*"
   }
   ```
3. S3 **Lifecycle rule**: expire `tenants/*/users/*/generated/*` after **1 day**.

**Object key structure:**
```
tenants/{tenant_id}/users/{user_id}/uploads/{filename}    ← permanent
tenants/{tenant_id}/users/{user_id}/generated/{filename}  ← ephemeral (24h)
tenants/{tenant_id}/users/{user_id}/vault/{filename}      ← vault source files
```

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
- **S3 required for multi-instance scaling:** Local mode stores files on the process's filesystem; incompatible with horizontal scaling.
- **Single tenant in practice:** `tenant_id` is hardcoded to `'default'` for all users. Tenant provisioning layer not implemented.
- **Vault mining is user-triggered:** No automatic re-mining on new uploads. Users click "Generate Ideas" when ready.
- **No vector search:** Vault chunks are plain text in Postgres, passed directly to Claude Sonnet in context. Works well for consultant-scale documents (10–100 pages). A vector index (e.g. `pgvector`) would be needed for large document libraries.

### Security
- **`token_encryption_key` is permanent:** No key rotation mechanism. Rotating orphans all stored LinkedIn tokens.
- **No PKCE on LinkedIn OAuth:** `state` parameter used for CSRF. PKCE would add additional protection.

### Scheduling
- **Requires Redis:** Without `REDIS_URL`, posts save but never auto-publish.
- **No job persistence across Redis flushes:** Pending jobs lost if Redis flushed (DB records remain; re-enqueued on next server restart).

### Metrics
- **Manual sync only:** Engagement metrics fetched explicitly via `POST /api/linkedin/sync-metrics`. No background polling.
- **90-day retention:** LinkedIn engagement data nulled after 90 days per ToS. Post content retained indefinitely.

---

## Recent Changes

### May 2026 — Sprint 1: Hook injection, Performance Tagging, Viral tension pre-check

| Change | Details |
|--------|---------|
| Hook archetype injection | `selectHook()` now runs on `restructureToPost()` (editorial path). `buildRefineSystemPrompt()` accepts optional `hookInjection` block. `archetype_used` persisted via all generation INSERT/UPDATE paths. |
| Post Performance Tagging | `routes/performance.js` — `POST /api/posts/:id/performance`, `GET /api/posts/performance-summary`, `GET /api/posts/untagged-published`. Dashboard: "Rate your posts" nudge card + "Content Intelligence" card. |
| Viral tension pre-check | `buildSubstancePrompt()` added. `ideaToPost()` and `restructureToPost()` throw `missing_substance` (HTTP 422) when both specificity and tension are absent. Frontend shows amber warning with "Generate anyway" bypass. |
| Migration | `018_performance_tagging.sql` — adds `archetype_used`, `performance_tag`, `performance_note`, `performance_tagged_at` to `generated_posts`. Run `DATABASE_URL=<prod> node scripts/migrate.js`. |

### April 2026 — Intelligence Vault + Funnel Intelligence

| Change | Details |
|--------|---------|
| Intelligence Vault | `vault_documents`, `vault_chunks`, `vault_ideas` tables; `services/vaultMiner.js`; `routes/vault.js`; `public/vault.html`; `public/ideas.html` |
| Funnel Intelligence | `funnelClassifier.js` (Claude Haiku); `routes/funnel.js`; `funnel_type` + `vault_source_ref` columns on `generated_posts`; funnel health widget in ideas.html + generate.html Tab B |
| generate.html Tab A / Tab B | Input tab toggle; Tab B loads vault seeds with funnel filter; "Use this idea" pre-fills Tab A and passes `vault_idea_id` |
| generate.js (route) | Accepts `vault_idea_id`; injects funnel hint into system prompt; stores `funnel_type` and `vault_source_ref` on generated post; marks seed `used` after generation |
| ideaPath.js | Added `_funnelHint` to the system prompt extras array |
| Dependencies added | `pdf-parse`, `mammoth` |
| Migration | `005_vault.sql` — run `DATABASE_URL=<prod> node scripts/migrate.js` on first deploy |

### April 2026 — S3 Storage Sprint

| Issue | Fix Applied |
|-------|-------------|
| Local disk blocks horizontal scaling | `services/storage.js` abstraction; S3 backend routes all file I/O through per-tenant S3 keys |

### April 2026 — Security & Compliance Audit

| Issue | Fix Applied |
|-------|-------------|
| Identity headers trusted for user/tenant | All identity now session-derived only |
| Rate limiter keyed by untrusted header | `keyGenerator` uses `req.userId` from session |
| Cross-tenant data access in queries | All UPDATE/SELECT in linkedin.js, linkedinPublisher.js, linkedinMetrics.js scope by `user_id` AND `tenant_id` |
| OAuth state stored in session | Moved to Redis with in-memory fallback |
| LinkedIn `email` scope included | Removed; scopes: `openid profile w_member_social` only |
| No token revocation on disconnect/GDPR delete | `revokeLinkedInToken()` added |
| Duplicate post risk on BullMQ retry | Idempotency guard on `linkedin_post_id` before API call |
| No retry / all failures permanent | 3-attempt exponential backoff; `NON_RETRIABLE_ERRORS` set |
| No reconnect notification on token expiry | `createReconnectNotification()` on refresh failure |
| Generated files served without auth | `serveAuthenticatedFile()` replaces open `express.static()` |
| No engagement data retention policy | 90-day cleanup job; `migrations/004_metrics_retention.sql` |
| LinkedIn API version drift | Standardised on `202501` |
| No graceful shutdown | SIGTERM/SIGINT handlers drain HTTP, BullMQ, Redis |
| No in-app notifications | `notifications` table + `routes/notifications.js` |
| Redis client not shared | `services/redis.js` added |

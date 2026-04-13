# ScoutHook

AI-powered LinkedIn content tool. Generate posts, schedule them, and track engagement — all from a single web UI.

---

## Tech Stack

- **Runtime:** Node.js + Express
- **Database:** PostgreSQL (Neon)
- **Queue / Scheduling:** BullMQ + Redis
- **AI:** Anthropic Claude (`@anthropic-ai/sdk`)
- **Auth:** Google OAuth (login), LinkedIn OAuth (publishing)
- **Storage:** Amazon S3 (`scout-hook-dev` / `scout-hook-prod`) or local disk in dev

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon/Postgres connection string |
| `SESSION_SECRET` | ✅ | Express session secret (use a long random string in prod) |
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth app client ID |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google OAuth app client secret |
| `GOOGLE_CALLBACK_URL` | ✅ | Google OAuth callback URL (e.g. `https://yourapp.com/auth/google/callback`) |
| `LINKEDIN_CLIENT_ID` | ✅ | LinkedIn OAuth app client ID |
| `LINKEDIN_CLIENT_SECRET` | ✅ | LinkedIn OAuth app client secret |
| `ANTHROPIC_API_KEY` | ✅* | Anthropic API key (* can be set via admin UI instead) |
| `REDIS_URL` | ⬜ | Redis connection string — required for scheduled post delivery |
| `TOKEN_ENCRYPTION_KEY` | ⬜ | 64-char hex AES key for LinkedIn token encryption. Set once, never rotate. Can be set via admin UI. Generate with: `openssl rand -hex 32` |
| `ADMIN_PASSWORD` | ⬜ | Password for `/admin.html` (default: `changeme`) |
| `PORT` | ⬜ | HTTP port (default: `4000`) |
| `NODE_ENV` | ⬜ | Set to `production` for secure cookies |
| `ALLOWED_ORIGIN` | ⬜ | CORS allowed origin if serving from a separate domain |
| `API_RATE_LIMIT_MAX` | ⬜ | Override default 2000 req/15min API rate limit |
| `STORAGE_BACKEND` | ⬜ | `local` (default) or `s3` |
| `S3_BUCKET_NAME` | ⬜* | Required when `STORAGE_BACKEND=s3`. Dev: `scout-hook-dev`, Prod: `scout-hook-prod` |
| `S3_REGION` | ⬜* | AWS region (e.g. `us-east-1`) |
| `AWS_ACCESS_KEY_ID` | ⬜* | IAM access key |
| `AWS_SECRET_ACCESS_KEY` | ⬜* | IAM secret key |
| `S3_KEY_PREFIX` | ⬜ | Optional key prefix for path-based env isolation (e.g. `dev/`) |
| `S3_ENDPOINT` | ⬜ | Custom endpoint for MinIO / LocalStack |

> ✅ = required &nbsp;·&nbsp; ⬜ = optional &nbsp;·&nbsp; ⬜* = optional unless `STORAGE_BACKEND=s3`

### Admin UI settings (`/admin.html`)

Sensitive keys can be stored in the database via the admin panel instead of env vars:

- `anthropic_api_key` — Anthropic API key
- `redis_url` — Redis connection string
- `token_encryption_key` — AES-256-GCM key for LinkedIn token encryption

---

## Local Setup

```bash
npm install
npm run migrate     # applies all pending DB migrations
npm start           # starts the server on PORT (default 4000)
```

Open `http://localhost:4000` — you'll be redirected to login.

---

## Features

### Auth
- Google OAuth login with server-side sessions
- All app HTML routes require an active session; API routes return 401 if unauthenticated

### LinkedIn Integration
- Connect/disconnect LinkedIn via OAuth with an explicit consent screen
- Publish posts (text, single image, PDF carousel) via `POST /api/linkedin/publish`
- LinkedIn tokens stored encrypted (AES-256-GCM); auto-refreshed 24h before expiry
- Token revoked on LinkedIn's auth server on disconnect and GDPR deletion
- Minimal scopes: `openid profile w_member_social` only

### AI Generation Pipeline
- Generate LinkedIn posts from a topic/idea (`POST /api/generate`)
- Hook classification across 8 archetypes (contrarian, story, how-to, listicle, etc.)
- Quality gate with retries enforces format rules
- Per-user rate limit: 10 generations/hour (Redis sliding window, in-memory fallback)

### Scheduling
- Schedule posts for future delivery via BullMQ + Redis
- 3-attempt exponential backoff (1 → 2 → 4 min) for transient failures
- Permanent failures (invalid token, invalid media URL, etc.) are marked `not_sent` without retry
- Pending jobs are re-enqueued on worker startup (crash recovery)
- **Scheduling is disabled if `REDIS_URL` is not configured** — posts save to DB but won't publish automatically

### Notifications
- In-app notification bell for publish success, publish failure, and LinkedIn reconnection reminders
- `GET /api/notifications` + `POST /api/notifications/read`

### Media Library
- Upload images and PDFs (`POST /api/media/upload`, 20MB max)
- Files stored in S3 (or local disk in dev) under a per-tenant/per-user prefix; metadata in `media_files` table
- Generated visuals auto-cleaned after 24h (S3 lifecycle rule in prod; hourly job in local mode); uploaded files retained permanently

### Visual Generation
- Generate quote cards, carousels, and branded quote images from post content
- Visuals rendered fully in memory (no temp disk writes) and stored via the storage abstraction
- Served at `/files/*` (auth-gated; owner-session-locked in S3 mode)

### Stats & Dashboard
- Monthly post count, average quality score, scheduled post count
- Recent and scheduled post lists

### Metrics & Retention
- Sync LinkedIn engagement metrics via `POST /api/linkedin/sync-metrics`
- Engagement data (likes, comments, reactions) is nulled after 90 days per LinkedIn API ToS

---

## Deploying to Render

1. Set all required env vars in the Render dashboard (Environment tab).
2. Add a Redis instance (Render Redis or Upstash) and set `REDIS_URL` — required for scheduled delivery.
3. Set `NODE_ENV=production` and a strong `SESSION_SECRET`.
4. Run migrations on first deploy: add `npm run migrate` as a pre-deploy command, or run it manually via the Render shell.
5. Set `token_encryption_key` via `/admin.html` — generate once with `openssl rand -hex 32` and never change it.
6. Set `STORAGE_BACKEND=s3`, `S3_BUCKET_NAME=scout-hook-prod`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` for S3 file storage. See [`docs/HANDOVER.md`](docs/HANDOVER.md) for the required IAM policy and S3 lifecycle rule.

The server handles `SIGTERM` gracefully: drains in-flight HTTP requests, closes the BullMQ worker, and disconnects the Redis client.

---

## Architecture & Detailed Docs

See [`docs/HANDOVER.md`](docs/HANDOVER.md) for the full technical reference: data model, all API endpoints, services, security model, LinkedIn compliance measures, and a complete list of recent audit fixes.

---

## Known Limitations

- **Requires Redis for scheduling:** Without `REDIS_URL`, posts save but are never auto-published.
- **S3 required for multi-instance scaling:** Set `STORAGE_BACKEND=s3` before running multiple replicas. Local disk mode stores files on the process's filesystem and is incompatible with horizontal scaling.
- **`token_encryption_key` is permanent:** No rotation mechanism exists. Rotating the key orphans all stored LinkedIn tokens.
- **Single-tenant in practice:** Multi-tenancy scaffolding (all tables have `user_id` + `tenant_id`) is in place, but tenant provisioning is not implemented — all users share `tenant_id = 'default'`.
- **Manual metrics sync:** Engagement metrics must be fetched explicitly; there is no background polling.

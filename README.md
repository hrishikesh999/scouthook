# ScoutHook

AI-powered LinkedIn content tool. Generate posts, schedule them, and track engagement — all from a single web UI.

---

## Tech Stack

- **Runtime:** Node.js + Express
- **Database:** PostgreSQL (Neon)
- **Queue / Scheduling:** BullMQ + Redis
- **AI:** Anthropic Claude (`@anthropic-ai/sdk`)
- **Auth:** Google OAuth (login), LinkedIn OAuth (publishing)
- **Storage:** Local disk (`/uploads`) for media files

---

## Environment Variables

These must be set before starting the server. API keys that change at runtime (Anthropic, Redis) can also be set via the admin UI at `/admin.html` and take precedence over env vars.

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
| `ADMIN_PASSWORD` | ⬜ | Password for `/admin.html` settings page (default: `changeme`) |
| `PORT` | ⬜ | HTTP port (default: `4000`) |
| `NODE_ENV` | ⬜ | Set to `production` for secure cookies and suppressed dev warnings |
| `ALLOWED_ORIGIN` | ⬜ | CORS allowed origin if serving from a separate domain |

### Admin UI settings (`/admin.html`)

Sensitive keys can be stored in the database via the admin panel instead of env vars:

- `anthropic_api_key` — Anthropic API key
- `redis_url` — Redis connection string
- `token_encryption_key` — AES-256-GCM key used to encrypt stored LinkedIn tokens (generate once, never change)

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
- All app routes require authentication

### LinkedIn Integration
- Connect/disconnect LinkedIn via OAuth (`/api/linkedin/status`, `routes/linkedin.js`)
- Publish posts (text, image, PDF carousel) with a 1 post/hour rate limit
- Encrypted token storage in Postgres

### AI Generation Pipeline
- Generate LinkedIn posts from a topic/idea (`routes/generate.js`)
- Hook classification across 8 archetypes (`services/hookSelector.js`)
- Quality gate with retries enforces format rules (`services/qualityGate.js`)
- Per-user in-memory rate limit: 10 generations/hour

### Scheduling
- Schedule posts via BullMQ + Redis (`services/scheduler.js`)
- Pending jobs are re-enqueued on worker startup
- **Scheduling is disabled if `REDIS_URL` is not configured** — posts insert to DB but won't publish automatically

### Media Library
- Upload images and PDFs (`routes/media.js`)
- Files stored in `/uploads`, metadata in `media_files` table
- List and delete media via API

### Stats & Dashboard
- Post engagement stats via `routes/stats.js`
- Dashboard fetches and renders stats client-side

---

## Deploying to Render

1. Set all required env vars in the Render dashboard (Environment tab).
2. Add a Redis instance (Render Redis or Upstash) and set `REDIS_URL` — required for scheduled delivery.
3. Set `NODE_ENV=production` and a strong `SESSION_SECRET`.
4. Run migrations on first deploy: add `npm run migrate` as a pre-deploy command or run it manually via the Render shell.

---

## Known Limitations

- **No shared rate limit store:** The in-memory API rate limiter doesn't sync across multiple Render instances. Use Redis-backed rate limiting if you scale horizontally.
- **No server-side retry for 429s:** Anthropic or LinkedIn 429/concurrency errors surface as generic failures. Backoff retries are not yet implemented.
- **Scheduling requires Redis:** Without Redis, posts are saved but never published automatically.
- **Multi-tenancy audit needed:** Endpoints derive user/tenant from session; confirm all DB queries are scoped by `user_id`/`tenant_id` before multi-user production use.
- **`token_encryption_key` is permanent:** Set it once and never rotate it, or stored LinkedIn tokens will become unreadable.

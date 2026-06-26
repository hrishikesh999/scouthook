# Twitter/X Publishing Integration

## Context

ScoutHook is awaiting LinkedIn API approval. Twitter/X is added as a parallel publishing platform. The integration must be first-class — Twitter gets a Typefully-style thread composer with live preview, not a tacked-on modal. Both platforms live as sibling tabs inside the existing post editor, sharing the same `post_id`, so the LinkedIn and Twitter workflows are parallel and independent but linked.

**Key decisions:**
- Tabs inside the existing editor (not a separate page) — industry best practice for multi-platform tools (Buffer, HubSpot, Later pattern)
- Twitter gets a dedicated Typefully-style split view: thread composer (left) + live preview (right)
- Scheduling uses the same modal as LinkedIn, but Twitter-aware
- Same `post_id` links both — one idea, two platform formats
- Separate `twitter.html` for connection management; `linkedin.html` unchanged

---

## UX Architecture

### The Editor: Two Platform Tabs

The editor gains a **platform tab bar** at the top:

```
[ LinkedIn | Draft ]   [ Twitter / X | 3 tweets ]          [Schedule >]
```

**LinkedIn tab** — existing editor, 100% unchanged. Nothing moves.

**Twitter / X tab** — full Typefully-style split view:
- **Left panel (composer):** Thread composer with tweet units. Each unit has an avatar, a plain text area, per-tweet char count (`106 / 280`), and per-tweet image/GIF attach buttons. Thread separator is visual (the next tweet card), not a keyboard shortcut. "Add to thread…" ghost card at the bottom.
- **Right panel (preview):** Live Twitter-style preview that updates in real time. Each tweet card shows handle, avatar, text, attached media, and the connector line between cards. A "High fidelity" toggle renders the exact Twitter card chrome.
- **Composer footer:** Thread summary (`3 tweets · 361 chars`), auto-number toggle, and a schedule preset button (opens the shared scheduling modal).
- **"Import from LinkedIn draft" button** in the toolbar seeds the thread from the LinkedIn tab's content, auto-splitting on paragraph breaks. User confirms before overwriting.

**Scheduling modal** (same component, Twitter-aware):
- When opened from the Twitter tab, the account strip shows Twitter handle + avatar
- Button reads "Post thread to Twitter now" (immediate) or the scheduled time
- Success sheet reads "Live on Twitter!" with a "View thread →" link

---

## Data Model Changes

### New Tables (3 migrations)

**`/migrations/064_platform_posts.sql`** — replaces `generated_posts.linkedin_post_id` cleanly:

```sql
CREATE TABLE platform_posts (
  id               bigserial PRIMARY KEY,
  post_id          bigint NOT NULL REFERENCES generated_posts(id) ON DELETE CASCADE,
  platform         text NOT NULL CHECK (platform IN ('linkedin', 'twitter')),
  platform_post_id text NOT NULL,
  platform_url     text,
  status           text NOT NULL DEFAULT 'published',
  published_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_posts_post_id ON platform_posts(post_id);

-- Backfill existing LinkedIn records
INSERT INTO platform_posts (post_id, platform, platform_post_id, published_at, created_at)
SELECT id, 'linkedin', linkedin_post_id, COALESCE(published_at, now()), COALESCE(published_at, now())
FROM   generated_posts
WHERE  linkedin_post_id IS NOT NULL;

-- Do NOT drop generated_posts.linkedin_post_id yet — keep for rollback.
-- Drop in a follow-up migration after prod verification.
```

**`/migrations/065_twitter_connections.sql`**:

```sql
CREATE TABLE twitter_connections (
  id                bigserial PRIMARY KEY,
  workspace_id      text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  authorized_by     text NOT NULL,
  account_key       text NOT NULL,          -- 'user_{twitter_user_id}'
  display_name      text,
  avatar_url        text,
  twitter_user_id   text NOT NULL,
  twitter_username  text NOT NULL,
  access_token_enc  text NOT NULL,
  refresh_token_enc text,
  expires_at        timestamptz NOT NULL,
  is_default        boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, account_key)
);
CREATE INDEX idx_twitter_connections_workspace ON twitter_connections(workspace_id);
CREATE UNIQUE INDEX idx_twitter_connections_default
  ON twitter_connections(workspace_id) WHERE is_default = true;
```

**`/migrations/066_scheduled_and_thread.sql`** — extends two existing tables:

```sql
-- Add platform tracking to scheduled_posts
ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS platform          text NOT NULL DEFAULT 'linkedin',
  ADD COLUMN IF NOT EXISTS connection_id     bigint,
  ADD COLUMN IF NOT EXISTS twitter_tweet_ids text;   -- JSON array; idempotency on retry

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_platform ON scheduled_posts(platform, status);
UPDATE scheduled_posts SET platform = 'linkedin' WHERE platform IS NULL;

-- Add Twitter thread content to generated_posts
ALTER TABLE generated_posts
  ADD COLUMN IF NOT EXISTS twitter_thread_json text;  -- JSON: [{text, image_url, numbering?}]
```

`twitter_thread_json` structure:
```json
[
  { "text": "Tweet 1 text...", "image_url": null, "numbered": true },
  { "text": "Tweet 2 text...", "image_url": "/files/cover.png", "numbered": true },
  { "text": "Tweet 3 text...", "image_url": null, "numbered": true }
]
```

---

## Bug Fixes (Required — Existing Latent Bugs)

These must ship with the Twitter integration since adding a second platform would trigger all of them:

| # | Location | Bug | Fix |
|---|---|---|---|
| 1 | `scheduler.js` `recoverStuckPosts()` | Re-enqueues ALL stuck posts as LinkedIn jobs | Read `platform` column; dispatch to correct publisher |
| 2 | `scheduler.js` BullMQ worker | `post-comment` job calls `publishFirstComment()` unconditionally | Guard: skip if `platform = 'twitter'` (first comment is LinkedIn-only) |
| 3 | `routes/linkedin.js` scheduled query | Returns ALL `scheduled_posts` with no filter; Twitter rows bleed through | Add `AND (platform IS NULL OR platform = 'linkedin')` |
| 4 | Rate limit check (publish route) | 1 post/hour limit is global per user across all platforms | Add `AND (platform IS NULL OR platform = 'linkedin')` to rate limit query; mirror separately in Twitter routes |
| 5 | `generated_posts.linkedin_post_id` | No way to record Twitter publish ID | Migrate to `platform_posts` (migration 064); backfill existing rows |

---

## New Services

### `/services/twitterOAuth.js`

Import `encrypt`/`decrypt` directly from `linkedinOAuth.js` — do not redefine.

PKCE state: reuse `redisSet`/`redisGet`/`redisDel` with prefix `twitter_oauth_state:`. Payload: `{ userId, tenantId, returnTo, codeVerifier }`. TTL: 10 min.

Functions:
- `generatePKCEPair()` — `crypto.randomBytes(32).toString('base64url')` as verifier; SHA-256 S256 for challenge
- `getValidAccessToken(workspaceId)` — refresh within **30 min** of expiry (Twitter tokens expire in 2h, not 60 days)
- `refreshConnectionToken(connection)` — POST to `https://api.twitter.com/2/oauth2/token` via HTTP Basic Auth; COALESCE existing refresh token if response omits it
- `revokeTwitterToken(connection)` — POST to `https://api.twitter.com/2/oauth2/revoke`; best-effort, swallow failures
- `notifyAllWorkspaceMembersReconnect(workspaceId)` — same pattern as LinkedIn version, Twitter-specific copy

### `/services/twitterPublisher.js`

**`publishNow(userId, tenantId, thread, options = {})`**
- `thread` is an array of `{ text, image_url, numbered }`
- Rate limit check (platform = 'twitter')
- Resolve connection (options.connectionId → workspace default)
- If `numbered`, prepend `(N/M)` to each tweet text
- For each tweet in sequence:
  - Upload image if `image_url` is set → `POST https://upload.twitter.com/1.1/media/upload.json` → `media_id`
  - If upload fails due to access tier, log warning and proceed without media
  - POST `https://api.twitter.com/2/tweets` with `{ text, media: { media_ids: [...] } }`
  - Chain replies via `reply.in_reply_to_tweet_id` from previous tweet's response
  - Collect tweet IDs
- Insert row into `platform_posts`: `{ post_id, platform: 'twitter', platform_post_id: tweet_ids[0], platform_url }`
- Update `generated_posts.status = 'published'`, `published_at = now()`
- Return `{ twitter_tweet_ids: string[], thread_url: string }`

**`publishScheduledPost(scheduledPostId, attemptInfo)`**
- Read `scheduled_posts` row; parse `twitter_thread_json` from the linked `generated_posts` row
- Idempotency guard: if `twitter_tweet_ids` is set, partial-publish already occurred — skip published tweets, continue from first unpublished
- Non-retriable errors: `not_connected`, `reconnect_required`, `rate_limit_exceeded`, Twitter 187 (duplicate), suspended account
- On success: write `twitter_tweet_ids`, insert into `platform_posts`, update `generated_posts.status`
- On failure: same in-app + email notification pattern as LinkedIn

---

## New Routes (`/routes/twitter.js`)

Mirrors `routes/linkedin.js` structure. OAuth 2.0 PKCE with scopes: `tweet.write users.read offline.access`.

| Endpoint | Notes |
|---|---|
| `GET /api/twitter/status` | `{ connected, name, username, photo_url, expires_in_days }` |
| `GET /api/twitter/connect` | Generate PKCE pair, store state in Redis, redirect to `twitter.com/i/oauth2/authorize` |
| `GET /api/twitter/callback` | Exchange code+verifier for tokens; fetch `/2/users/me?user.fields=profile_image_url,name,username`; upsert `twitter_connections`; redirect to `/twitter.html` |
| `GET /api/twitter/connections` | List workspace connections |
| `DELETE /api/twitter/connections/:id` | Revoke token, cancel pending Twitter scheduled posts, delete row |
| `POST /api/twitter/connections/:id/set-default` | Swap `is_default` |
| `POST /api/twitter/publish` | Body: `{ thread, postId, connectionId }`. Validate each tweet ≤ 280 chars. Call `publishNow`. |
| `POST /api/twitter/schedule` | Body: `{ thread, scheduled_for, post_id, connectionId }`. Guardrails filtered to `platform = 'twitter'`. |
| `GET /api/twitter/scheduled` | List pending Twitter scheduled posts |
| `DELETE /api/twitter/scheduled/:id` | Cancel a scheduled Twitter post |
| `DELETE /api/twitter/user-data` | GDPR: revoke tokens, cancel posts, delete connections |

Token exchange: HTTP Basic Auth with `TWITTER_CLIENT_ID:TWITTER_CLIENT_SECRET` in both the Authorization header and body (Twitter docs are ambiguous for confidential clients — send both).

---

## Scheduler Fix (`/services/scheduler.js`)

**`recoverStuckPosts()` fix:**
```javascript
const platformRow = await db.query('SELECT platform FROM scheduled_posts WHERE id = $1', [row.id]);
if (platformRow?.platform === 'twitter') {
  await addScheduledJob(row.id, new Date(row.scheduled_for), 'twitter');
} else {
  await addScheduledJob(row.id, new Date(row.scheduled_for), 'linkedin');
}
```

**BullMQ worker fix:**
```javascript
if (job.name === 'post-comment') {
  // First comment is LinkedIn-only
  const row = await db.query('SELECT platform FROM scheduled_posts WHERE id = $1', [scheduledPostId]);
  if (row?.platform !== 'twitter') await publishFirstComment(scheduledPostId);
  return;
}
const row = await db.query('SELECT platform FROM scheduled_posts WHERE id = $1', [scheduledPostId]);
if (row?.platform === 'twitter') {
  const { publishScheduledPost } = require('./twitterPublisher');
  await publishScheduledPost(scheduledPostId, attemptInfo);
} else {
  await publishScheduledLinkedInPost(scheduledPostId, attemptInfo);
}
```

---

## Server.js Changes

Mount router (same `callback` exemption pattern as LinkedIn):
```javascript
app.use('/api/twitter',
  (req, res, next) => req.path === '/callback' ? next() : requireWorkspaceMember(req, res, next),
  requireWorkspaceActive,
  require('./routes/twitter'));
```

Add to Helmet CSP `imgSrc`: `"pbs.twimg.com"` (Twitter avatar CDN).

---

## Frontend Changes

### `GET /api/posts/:id` (or equivalent)
Extend the post-fetch response to include `twitter_thread_json` so the editor can populate the Twitter tab on load.

### `PUT /api/posts/:id/twitter-thread`
New endpoint to save the Twitter thread JSON as the user edits in the composer. Called on debounce (same as LinkedIn's auto-save pattern).

### `/public/editor.html` — Platform Tabs + Twitter Composer

**Tab bar** (added to editor header, between back button and schedule button):
```html
<div id="platform-tabs">
  <button id="tab-linkedin" class="ptab active">
    <i class="ti ti-brand-linkedin"></i> LinkedIn
    <span class="ptab-badge" id="li-status-badge">Draft</span>
  </button>
  <button id="tab-twitter" class="ptab">
    <i class="ti ti-brand-x"></i> Twitter / X
    <span class="ptab-badge" id="tw-status-badge">Not set up</span>
  </button>
</div>
```

**LinkedIn panel** (`#linkedin-panel`): wraps the existing editor. No changes inside.

**Twitter panel** (`#twitter-panel`, hidden by default): new split-view layout:
- Left: `#thread-composer` — tweet units rendered as a scrollable list
- Right: `#thread-preview` — live Twitter card preview, updates on every keydown
- Footer: thread summary, auto-number toggle, schedule shortcut

**Tweet unit template** (cloned per tweet):
```html
<div class="tweet-unit" data-idx="0">
  <div class="tu-avatar">SH</div>
  <div class="tu-body">
    <div class="tu-meta">@handle <span class="tu-num">1 / 3</span></div>
    <textarea class="tu-text" maxlength="280"></textarea>
    <div class="tu-actions">
      <button class="tu-img-btn">Image</button>
      <button class="tu-gif-btn">GIF</button>
      <span class="tu-chars">0 / 280</span>
      <button class="tu-remove">×</button>
    </div>
  </div>
</div>
```

**State:**
```javascript
let activePlatform = 'linkedin';  // 'linkedin' | 'twitter'
let twitterThread  = [];          // [{ text, image_url, numbered }]
let twitterConnected = false;
let selectedTwitterConnectionId = null;
let autoNumber = true;
```

**`checkTwitterStatus()`**: calls `GET /api/twitter/status` and `GET /api/twitter/connections` in parallel (same pattern as `checkLinkedInStatus()`). Updates `twitterConnected` and `selectedTwitterConnectionId`.

**`renderThread()`**: rebuilds the composer and preview from `twitterThread[]`. Called on every edit.

**`importFromLinkedIn()`**: splits the LinkedIn editor content on `\n\n`, creates tweet units, prompts "Replace your Twitter thread with the LinkedIn draft?" before applying.

**Scheduling modal changes** (minimal): when `activePlatform === 'twitter'`, the modal's account strip shows Twitter handle/avatar, the immediate-publish button reads "Post thread to Twitter now", the success sheet reads "Live on Twitter!". The payload sent is `{ thread: twitterThread, post_id, connectionId, scheduled_for }` to `/api/twitter/schedule` or `/api/twitter/publish`. Everything else in the modal stays the same.

### `/public/twitter.html` (new connection management page)

Mirrors `linkedin.html` structure. Shows connected Twitter account (handle, avatar, token expiry), connect button → `/api/twitter/connect`, disconnect with confirmation.

### `/public/js/settings-nav.js`
Add after the LinkedIn tab:
```javascript
{ label: 'Twitter / X', href: '/twitter.html' },
```

### `/public/js/sidebar.js`
Add to `activeOverrides`:
```javascript
'/twitter.html': '/settings.html',
```

---

## Environment Variables (New)

```
TWITTER_CLIENT_ID        — OAuth 2.0 App Client ID (developer.twitter.com)
TWITTER_CLIENT_SECRET    — OAuth 2.0 App Client Secret
TWITTER_REDIRECT_URI     — https://app.scouthook.com/api/twitter/callback
```

`TOKEN_ENCRYPTION_KEY` is shared — no new key needed.

---

## Files Summary

| File | Action |
|---|---|
| `/migrations/064_platform_posts.sql` | Create |
| `/migrations/065_twitter_connections.sql` | Create |
| `/migrations/066_scheduled_and_thread.sql` | Create |
| `/services/twitterOAuth.js` | Create |
| `/services/twitterPublisher.js` | Create |
| `/routes/twitter.js` | Create |
| `/public/twitter.html` | Create |
| `/services/scheduler.js` | Fix bugs #1 and #2 above |
| `/routes/linkedin.js` | Fix bugs #3 and #4 above |
| `/server.js` | Mount `/api/twitter` router; update Helmet CSP |
| `/public/editor.html` | Add platform tabs, Twitter panel, thread composer, preview, `checkTwitterStatus()`, `renderThread()`, modal Twitter-awareness |
| `/public/js/settings-nav.js` | Add Twitter tab |
| `/public/js/sidebar.js` | Add `activeOverride` |

---

## Verification

1. Run migrations 064, 065, 066; confirm `platform_posts` backfill count matches prior `linkedin_post_id` count
2. Set `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET`, `TWITTER_REDIRECT_URI` in `.env`
3. Visit `/twitter.html` → Connect → complete OAuth → confirm handle appears
4. Open any post in the editor → click "Twitter / X" tab → composer and preview load correctly
5. Click "Import from LinkedIn draft" → thread auto-populates from LinkedIn content
6. Edit tweet text → confirm preview panel updates in real time
7. Add an image to tweet 2 → confirm preview shows media card
8. Click Schedule → modal shows Twitter account strip and "Post thread to Twitter now"
9. Publish immediately → confirm thread appears on Twitter; `platform_posts` row inserted
10. Schedule a thread → confirm BullMQ job fires at the right time
11. Disconnect Twitter → confirm pending Twitter scheduled posts are cancelled
12. Switch back to LinkedIn tab → publish as normal → confirm existing LinkedIn flow unchanged (regression)
13. Verify LinkedIn schedule page shows zero Twitter posts (bug fix #3 verified)

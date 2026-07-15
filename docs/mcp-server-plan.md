# ScoutHook MCP Server — Build Plan

**Status:** Phase 0–2 SHIPPED (read + write tools on personal-token auth) · 2026-07-15
**Decision:** build now, list in the directory later (§7). No Team seat purchased yet.
**Author:** drafted 2026-07-15
**Audience:** founder (non-technical) + whoever builds it
**Primary objective:** get **publicly listed in the Claude Connectors Directory**
— it's a lead source. This makes OAuth 2.1 a day-one requirement (not optional)
and adds a set of Anthropic review bars (see §12).

> **Read this first — account prerequisite that has nothing to do with code:**
> To submit to the directory you (ScoutHook, the company) need a **Claude Team or
> Enterprise organization**. The submission portal lives inside Claude.ai admin
> settings, which individual/Pro plans don't have. Only the org Owner (or a
> delegated role on Enterprise) can submit. Sort this out early — it's a
> purchase + login, not engineering, but nothing ships to the directory without
> it.
>
> **Who pays / who needs what (important):** the Team/Enterprise requirement is
> on **ScoutHook the publisher only**, and only for submitting + managing the
> listing. Team plan = **5-seat minimum, ~$125/mo ($100/mo annual = $1,200/yr)**.
> **End users need nothing special** — directory connectors are usable on *every*
> Claude plan including **Free**. So this cost is one-sided (publisher) and does
> not shrink the reachable audience; it's purely the price of being discoverable.
> Building the connector and shipping it as a **custom connector (users paste a
> URL)** needs *no* Team seat at all — only the directory *listing* does.

---

## 1. Goal in one sentence

Let ScoutHook users control ScoutHook from inside Claude (and other MCP-aware
apps) — draft posts in their own voice, pull their idea cards, save to vault,
check performance — without leaving the chat. ScoutHook stays the brain; the MCP
server is a thin translator in front of logic we already have.

## 2. Why this is cheap for us specifically

The hard parts are already built. Every ScoutHook API route already:

- reads the logged-in user's `req.userId` and workspace `req.tenantId` from the
  session (`server.js:308-313`) — never from headers, so tenants can't spoof
  each other;
- calls a **service** that does the real work (`getDailyCards`, `ideaToPost`,
  `mintQuestionCard`, the 10 guided-post generators in `services/*Path.js`);
- runs through quota, rate-limit, and plan-feature checks
  (`canGeneratePost`, `checkRateLimit`, `requireFeature`,
  `services/subscription.js`).

The MCP server does **not** re-implement any of that. Each MCP "tool" is a small
wrapper that (a) figures out which user is calling, (b) calls the exact same
service function a route already calls, (c) returns the result. If we build it
right, a new capability in ScoutHook becomes a new MCP tool in ~20 lines.

## 3. Architecture decision

**Embed the MCP endpoint inside the existing Express app** — do NOT stand up a
separate service.

```
Claude / any MCP client
        │  (Streamable HTTP + OAuth)
        ▼
POST /mcp   ← new route on the SAME server.js app
        │
        ▼
MCP tool handlers  ← new, thin
        │
        ▼
existing services/  ← unchanged (ideaPath, ideaEngine, subscription, …)
        │
        ▼
Postgres (db/pg)   ← unchanged
```

Why embedded, not separate:

- reuses the session/auth model, the services layer, quota logic, Redis, and the
  DB pool with zero duplication;
- one deploy, one place to reason about multi-tenancy;
- the MCP spec's remote transport (**Streamable HTTP**) is literally just an HTTP
  endpoint — Express is already what we run.

Transport: **Streamable HTTP** (the current remote-server transport in the MCP
spec). Not stdio — stdio is for local desktop tools, not a hosted SaaS.

Library: **`@modelcontextprotocol/sdk`** (official, MIT-licensed, free). It
provides `McpServer` + a Streamable HTTP transport we mount on the `/mcp` route.

## 4. The one genuinely new piece: authentication

Today ScoutHook auth = Google login → Express session cookie. Claude can't send
a session cookie; the MCP spec expects **OAuth 2.1**. So the connect flow becomes:

1. User adds "ScoutHook" as a connector in Claude and clicks Connect.
2. Claude opens ScoutHook's authorize page in a browser.
3. User logs in with Google (the flow we already have) and clicks "Allow Claude
   to access my ScoutHook workspace."
4. ScoutHook issues an access token bound to that `user_id` + `tenant_id`.
5. Every MCP tool call from Claude carries that token; our server resolves it
   back to the user, sets the same `userId`/`tenantId` the routes expect, and
   proceeds. Same isolation guarantees as the web app.

Because the goal is a public directory listing, **OAuth is required — there is no
"skip it" version that gets listed.** Anthropic's submission rules mandate OAuth
for any authenticated service. We can still use a personal token internally
during development (§7 Phase 0–2) to move fast, but the listing needs the real
thing.

**What "the real thing" concretely means** (from Anthropic's connector docs):

- **OAuth 2.1 with PKCE** (S256 code-challenge method).
- **Protected Resource Metadata** hosted at
  `/.well-known/oauth-protected-resource` (RFC 9728) — this is how Claude
  discovers where to send the user to authorize.
- One of these client-registration modes, all supported by the directory:
  **dynamic client registration** (RFC 7591), a **client-ID metadata document**,
  or a **static client ID** you pre-share with Anthropic. Dynamic registration is
  the least-coordination path.
- The authorize/token endpoints (`/authorize`, `/token`) bound to our existing
  Google-login session, issuing tokens scoped to `{user_id, tenant_id}`.

Lean on a maintained OAuth-server library so we're not hand-rolling crypto or
token storage. The flow reuses our current Google login for the actual
"who are you" step — OAuth just wraps it so Claude can obtain a token.

## 5. Tool catalog

Ship read-only first (low risk, instantly useful), then write tools.

### v1 — read-only (Phase 1)

| Tool | What it does | Wraps (existing) |
|------|--------------|------------------|
| `list_todays_ideas` | Return today's idea cards | `ideaEngine.getDailyCards(userId, tenantId)` — `routes/ideas.js:53` |
| `get_idea_queue` | Upcoming/queued idea cards | queue query in `routes/ideas.js:86` |
| `get_post_performance` | Recent post stats & engagement | `routes/stats.js` / `routes/performance.js` |
| `search_vault` | Find saved source material | vault query layer in `routes/vault.js` |
| `whoami` | Confirm connected workspace + plan | `subscription.getUserPlan(userId)` |

### v2 — write / action (Phase 2)

| Tool | What it does | Wraps (existing) |
|------|--------------|------------------|
| `generate_post` | Draft a LinkedIn post in the user's voice | the dispatch in `routes/generate.js:174` → `ideaToPost` / the 10 `*Path.js` generators |
| `generate_from_idea` | Turn a specific idea card into a post | `ideaPath.ideaToPost(...)` + `ideaEngine.stampIdeaCard` |
| `save_to_vault` | Store a link/note as source material | vault insert in `routes/vault.js` |
| `mint_question_card` | Create a new prompt/question idea card | `ideaEngine.mintQuestionCard(userId, tenantId)` — `routes/ideas.js:174` |

**Critical rule for every tool:** it must go through the **same quota,
rate-limit, and plan-feature checks** the HTTP route does. `generate_post`
especially must call `canGeneratePost` and `checkRateLimit` before generating —
otherwise the MCP becomes a way to bypass billing limits. Enforce this by having
tools call the service layer, which is where those checks live, rather than
touching the DB directly.

### Tool spec example — `generate_post`

```
name: generate_post
description: Draft a LinkedIn post in the user's own voice (Voice DNA).
input:
  raw_idea        (string, required)  — what the post is about
  post_type       (enum,   optional)  — one of the 10 guided types; default auto
  length_preference (enum, optional)  — short | medium | long
output:
  post_id, body_text, hook, hashtags, quality_gate_status, edit_url
errors:
  monthly_quota_reached  → tell user their limit + reset date + upgrade link
  rate_limit_exceeded    → tell user to retry after N seconds
  feature_not_available  → e.g. carousel needs Pro
```

The error shapes already exist verbatim in `routes/generate.js:184-208` — reuse
them so Claude can give the user an accurate, friendly message.

## 6. Multi-tenancy & security (non-negotiable)

- Token → `{userId, tenantId}` resolution happens once, at the top of the MCP
  request, exactly like `server.js:308-313`. Tools never accept a workspace id
  as an argument.
- Every DB read/write stays scoped by `tenantId` (all our queries already are).
- Scope the token to the workspace that was active at authorize time; if we later
  support multi-workspace, add a `switch_workspace` tool rather than trusting an
  argument.
- Rate-limit the `/mcp` endpoint itself (`express-rate-limit`, already a dep).
- Log MCP tool calls to the admin activity log we already have, tagged
  `source: mcp`, so we can see usage and abuse.
- Access tokens: short-lived + refresh, revocable from ScoutHook settings
  ("Disconnect Claude").

## 7. Milestones & rough effort

Because the directory listing is the objective, OAuth is no longer deferrable —
but we still build the tool layer first on a personal token so engineering isn't
blocked on auth. Order:

| Phase | Deliverable | Effort |
|-------|-------------|--------|
| — | **(Non-eng, do in parallel)** Buy a Claude **Team/Enterprise** seat for ScoutHook; write the public **privacy policy** for the connector; prep icon + listing copy | ~1 day + legal review |
| 0 | Spike: mount `@modelcontextprotocol/sdk` on `/mcp`, one `whoami` tool, connect from Claude via a temporary personal token | 1–2 days |
| 1 | All v1 read tools, each with `title` + `readOnlyHint` annotations; admin logging | 3–4 days |
| 2 | v2 write tools with full quota/feature enforcement + `destructiveHint` annotations | 3–5 days |
| 3 | **OAuth 2.1 + PKCE authorization server** (`/.well-known/oauth-protected-resource`, `/authorize`, `/token`, dynamic client registration), tokens scoped to `{userId, tenantId}`, "Disconnect Claude" revocation UI | 5–8 days |
| 4 | Populated test account, run every tool via MCP Inspector, screenshots, submit through the portal, respond to reviewer feedback | 2–4 days + review wait |

**Realistic total to a live listing:** ~4–5 weeks of engineering, plus Anthropic's
review queue (variable — days to a couple of weeks). Phase 3 (OAuth) is the
critical path and the main risk.

Recommended path: build Phases 0–2 on a personal token so the tool layer is
proven and dogfoodable fast, then do Phase 3 OAuth and Phase 4 submission. Don't
try to shortcut Phase 3 — the directory gate is hard on it.

## 8. Testing

- Unit-test each tool handler against the service layer (our Jest setup, but see
  `memory/reference_running_tests.md` — **must** run on the Neon test branch with
  `.env.test`, never against prod).
- Integration: use MCP Inspector (the SDK's dev tool) to exercise tools locally
  before touching Claude.
- Verify a tenant-isolation test: token for workspace A can never read/write
  workspace B's rows.

## 9. Distribution / go-to-market

- Beta: share a "custom connector" URL + personal-token instructions.
- Public: once OAuth ships, submit to Claude's connector directory. For a
  LinkedIn-content audience that already lives in AI tools, being a listed Claude
  connector is real, cheap marketing and a differentiator — few competitors in
  our space have one.
- Ties directly to the Camp 2 positioning: "your LinkedIn content system,
  available wherever you work."

## 10. Open questions to decide before Phase 3

1. One token per user, or per (user × workspace)? Affects multi-workspace UX.
2. Do we let `generate_post` actually publish to LinkedIn, or only draft +
   return an `edit_url`? (Recommend draft-only first — publishing is a
   higher-trust action.)
3. Do free-trial users get MCP access, or is it a Pro-gated feature? (Could be a
   nice upgrade lever.)

## 12. Directory listing requirements (the actual gate)

These are Anthropic's stated bars for the Connectors Directory. Treat as the
Phase-4 checklist. Sources at the bottom.

**Hard prerequisites**

- [ ] ScoutHook has a **Claude Team or Enterprise org**; Owner submits via the
      admin-settings submission portal. (Individual/Pro plans can't submit.)
- [ ] Server is **remote, cloud-hosted, public HTTPS** — our production Express
      app qualifies.
- [ ] Transport is **Streamable HTTP** (SSE is deprecated and gets rejected).

**Tools**

- [ ] **Every tool** has a `title` and either `readOnlyHint` (the v1 read tools)
      or `destructiveHint` (write tools like `save_to_vault`). The portal
      auto-syncs tools and flags any missing annotation — an unannotated tool
      blocks submission.

**Auth**

- [ ] **OAuth 2.1 + PKCE**, Protected Resource Metadata at
      `/.well-known/oauth-protected-resource`, one supported client-registration
      mode (dynamic registration is simplest).

**Privacy & docs (common rejection reasons)**

- [ ] **Public privacy policy URL** covering data collection, usage/storage,
      third-party sharing, retention, and contact. *Missing or incomplete =
      immediate rejection.* This is the single most common failure — write it
      early.
- [ ] Public **documentation URL** with clear setup + usage instructions.
- [ ] Support contact.

**Test & launch**

- [ ] A **fully populated test account** (a workspace with Voice DNA, idea cards,
      vault items, some posts) plus step-by-step access instructions for the
      reviewer.
- [ ] You've personally run **every tool** end-to-end via **MCP Inspector** or as
      a custom connector in Claude.

**Listing assets** (entered in the portal)

- [ ] Name (≤100 chars), tagline (≤55), description (≤2000), 1–5 categories,
      icon, permanent URL slug (**cannot change after publish** — choose
      carefully).

**Nice-to-have UX**

- [ ] **Allowed link URIs**: declare our own origins (e.g. `https://scouthook.com`
      / the app domain) so when a tool returns an `edit_url` or `upgrade_url`,
      Claude doesn't prompt the user to confirm every link. Only list domains we
      own.

**Compliance**

- [ ] Seven policy acknowledgments in the portal (directory guidelines,
      first-party API usage, financial transactions, AI-media generation, prompt
      injection, conversation-data collection, public documentation). All
      required.

Escalations/questions: `mcp-review@anthropic.com`.

### Sources

- [Submitting to the Connectors Directory — Anthropic docs](https://claude.com/docs/connectors/building/submission)
- [Anthropic Connectors Directory FAQ — Claude Help Center](https://support.claude.com/en/articles/11596036-anthropic-connectors-directory-faq)
- [Claude Connector OAuth Authentication (May 2026) — sunpeak](https://sunpeak.ai/blogs/claude-connector-oauth-authentication/)

## 14. What's built so far (Phase 0–1, 2026-07-15)

Shipped and verified end-to-end against the Neon **test** branch (initialize
handshake, `tools/list`, `tools/call whoami`, and a 401 for a missing token):

- `migrations/074_mcp_tokens.sql` — hashed personal-access-token table, scoped to
  `user_id` + `tenant_id`. **Not yet applied to prod** — run the migration on
  deploy.
- `lib/mcpTokens.js` — mint / verify / list / revoke. Stores only SHA-256 hashes;
  raw token shown once.
- `routes/mcp.js` — the MCP server. Streamable HTTP (stateless), bearer auth,
  three read-only tools: `whoami`, `list_todays_ideas`, `get_idea_queue`, each
  annotated `readOnlyHint`. Exports `buildServer` for testing.
- `server.js` — mounts `app.use('/mcp', …)` outside the session-only `/api` chain.
- `scripts/mint-mcp-token.js` — CLI to issue a token for a user/workspace.

**Try it (against test or a deployed instance):**
```
node scripts/mint-mcp-token.js --user <userId>
# then in Claude → Connectors → Add custom connector:
#   URL:  <APP_URL>/mcp     Auth: paste the Bearer token
```

### Phase 2 added (2026-07-15) — write tools

- `services/mcpGenerate.js` — one entry point that turns a raw idea into a saved
  post: runs `canGeneratePost` (the SAME monthly billing quota as the web app)
  FIRST, resolves the workspace Voice DNA profile, generates via the same
  `*Path.js` / `ideaToPost` generators, runs the same `runQualityGate`, and
  persists to `generation_runs` + `generated_posts` exactly like
  `routes/generate.js`. Throws typed errors (quota / no-voice-profile /
  missing-substance) that the tools turn into friendly messages.
- `routes/mcp.js` — two new tools, **write-scope-gated**:
  - `generate_post` (raw_idea, optional post_type, optional length) →
    `{ post_id, post, quality, edit_url }`.
  - `generate_from_idea` (idea_card_id) → same, seeded from a saved idea card.
- Tokens now default to `read,write` scope; a `--scopes read` token is refused by
  the write tools. Mint script gained `--scopes`.

Verified on the test branch: 5 tools list with correct annotations; a read-only
token is refused; an over-quota user is stopped by the billing gate BEFORE any
LLM call (proving MCP can't bypass billing); nothing persists on the error path.
The successful-generation path reuses the web app's proven generator + persistence
and is best confirmed live with a real Voice-DNA workspace via the mint script.

### Self-serve token UI added (2026-07-15)

- `routes/mcpTokens.js` — session-authed, workspace-scoped `GET/POST/DELETE
  /api/mcp-tokens` (mounted under `requireWorkspaceMember`). Mint returns the raw
  token once; list returns prefixes only; delete revokes.
- `public/account.html` — a "Connect Claude" card showing the connector URL,
  a create-token flow (reveal-once + copy), and a list with revoke.
- `public/js/mcp-connector.js` — the card's logic.

Users can now self-serve: create a token on the account page, paste it + the
connector URL into Claude → custom connector. No CLI needed. Verified the API
end-to-end on the test branch (create → list without secret → token verifies with
read,write → revoke invalidates → 404 on unknown id).

**Not yet done** (next, in order): `save_to_vault` + `mint_question_card` write
tools; Phase 3 OAuth 2.1 (required only for the directory listing); apply
migration 074 to prod on deploy. Visual QA of the account.html card is best done
in the running app (it follows the existing profile-card patterns).

## 13. "Vice versa" note

The reverse direction — ScoutHook using Claude — already exists: the generation
engine calls the Anthropic API internally (`@anthropic-ai/sdk` in
`package.json`). No MCP needed there. "MCP for ScoutHook" is specifically the
Claude → ScoutHook direction described above.

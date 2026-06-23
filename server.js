'use strict';

require('dotenv').config();

const express = require('express');
require('express-async-errors');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { db } = require('./db');
const { pool: dbPool } = require('./db/pg');
const { sendEmail } = require('./emails');
const { seedTrialSubscription } = require('./services/subscription');
const affiliatesService = require('./services/affiliates');
const { scheduleReconciler } = require('./services/affiliateReconciler');
const cookie = require('cookie');

// Initialise DB adapter (schema is managed by migrations)
require('./db');
const { runSeed } = require('./config/seedData');

const app = express();

// ---------------------------------------------------------------------------
// Security middleware
// ---------------------------------------------------------------------------

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", "https://cdn.paddle.com", "https://public.profitwell.com", "https://assets.calendly.com"],
      styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.paddle.com", "https://assets.calendly.com"],
      imgSrc:         ["'self'", "data:", "*.licdn.com", "media.licdn.com", "*.googleusercontent.com", "*.placid.app", "*.amazonaws.com"],
      connectSrc:     ["'self'", "https://sandbox-api.paddle.com", "https://api.paddle.com", "https://cdn.paddle.com", "https://buy.paddle.com", "https://sandbox-buy.paddle.com", "https://calendly.com"],
      fontSrc:        ["'self'", "https://fonts.gstatic.com"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
      frameSrc:       ["https://sandbox-buy.paddle.com", "https://buy.paddle.com", "https://calendly.com"],
    },
  },
}));

const allowedOrigin = process.env.ALLOWED_ORIGIN || null;
if (allowedOrigin) {
  app.use(cors({ origin: allowedOrigin, credentials: true }));
}

// Paddle webhook route removed — subscription state is managed entirely via
// direct Paddle API calls in /api/billing/sync (post-checkout) and
// /api/billing/subscription (stale-refresh on every subscription GET).

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------------------
// Auth (Google OAuth) + session
// ---------------------------------------------------------------------------

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable is required. Set a strong random string (e.g. openssl rand -hex 32).');
}
const SESSION_SECRET = process.env.SESSION_SECRET;

// TOKEN_ENCRYPTION_KEY: required for LinkedIn token encryption/decryption.
// Without it every LinkedIn connect and publish attempt throws at runtime.
// In production we fail fast; in development we warn so local testing can run without LinkedIn.
const _tek = (process.env.TOKEN_ENCRYPTION_KEY || '').trim();
if (!_tek) {
  const msg = 'TOKEN_ENCRYPTION_KEY is not set — LinkedIn connections will fail at runtime. Generate with: openssl rand -hex 32';
  if (process.env.NODE_ENV === 'production') {
    throw new Error(msg);
  } else {
    console.warn(`[startup] WARNING: ${msg}`);
  }
} else if (_tek.length !== 64) {
  throw new Error('TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Generate with: openssl rand -hex 32');
}

// ALLOWED_ORIGIN: only required when frontend and backend are on different origins.
// If both are served from the same domain this can be left unset.
// Warn in production so the operator knows it must be intentional.
if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGIN) {
  console.warn('[startup] WARNING: ALLOWED_ORIGIN is not set. If your frontend is on a different origin than the API, cross-origin requests will be rejected by the browser. Set ALLOWED_ORIGIN=https://app.yourdomain.com to enable CORS.');
}

// REDIS_URL: required in production. Without Redis, OAuth CSRF state uses an
// in-process Map that breaks on multi-instance deployments (state stored by
// one instance is invisible to others), causing LinkedIn OAuth to fail for ~50%
// of logins. Scheduling also requires Redis (BullMQ).
if (process.env.NODE_ENV === 'production' && !process.env.REDIS_URL) {
  throw new Error('REDIS_URL is required in production. Set REDIS_URL to your Redis connection string.');
}

app.set('trust proxy', 1); // needed on Render/behind proxies for secure cookies

const PgSession = connectPgSimple(session);
app.use(session({
  name: 'scouthook.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new PgSession({
    pool: dbPool,
    tableName: 'session',
    // Disable pruning in tests — the timer keeps the event loop alive past --forceExit.
    pruneSessionInterval: process.env.NODE_ENV === 'test' ? false : 60 * 15,
  }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
  },
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || null;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || null;

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: GOOGLE_CALLBACK_URL || '/auth/google/callback',
  }, async (accessToken, refreshToken, profile, done) => {
    const email = profile?.emails?.[0]?.value || null;
    const photo = profile?.photos?.[0]?.value || null;
    const googleId = profile?.id || null;
    const userId = googleId ? `google:${googleId}` : (email ? `google_email:${email}` : null);
    console.log(`[auth/google] login email=${email} googleId=${googleId} userId=${userId}`);
    if (!userId) return done(null, false);

    try {
      const displayName = profile?.displayName || email || 'User';

      // 1. Upsert identity row (identity-only — no voice DNA or brand columns post-migration)
      const result = await db.prepare(`
        INSERT INTO user_profiles (user_id, email, display_name)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          email        = EXCLUDED.email,
          display_name = EXCLUDED.display_name
        RETURNING (xmax = 0) AS is_new_row
      `).get(userId, email, displayName);

      // 2. Upsert auth_providers row (idempotent on every login)
      await db.prepare(`
        INSERT INTO auth_providers (user_id, provider, provider_id)
        VALUES (?, 'google', ?)
        ON CONFLICT(provider, provider_id) DO NOTHING
      `).run(userId, googleId || email || userId);

      // 3. Resolve workspace — prefer last active, fall back to oldest non-deleted
      let workspaceId;
      try {
        const upRow = await db.prepare(
          'SELECT last_active_workspace_id FROM user_profiles WHERE user_id = ?'
        ).get(userId);
        if (upRow?.last_active_workspace_id) {
          const ws = await db.prepare(
            'SELECT id FROM workspaces WHERE id = ? AND deleted_at IS NULL'
          ).get(upRow.last_active_workspace_id);
          if (ws) workspaceId = ws.id;
        }
      } catch { /* last_active_workspace_id column missing — migration 038 not yet applied */ }

      if (!workspaceId) {
        const membership = await db.prepare(
          `SELECT wm.workspace_id FROM workspace_members wm
           JOIN workspaces w ON w.id = wm.workspace_id
           WHERE wm.user_id = ? AND w.deleted_at IS NULL
           ORDER BY wm.created_at ASC LIMIT 1`
        ).get(userId);

        if (membership) {
          workspaceId = membership.workspace_id;
        } else {
          // Before creating a personal workspace, check for a pending invite.
          // If one exists the user came here via an invite link — skip workspace
          // creation so no orphaned empty workspace is left behind.
          const pendingInvite = email ? await db.prepare(`
            SELECT workspace_id FROM workspace_invites
            WHERE  LOWER(email) = LOWER(?)
              AND  accepted_at IS NULL
              AND  expires_at  > now()
            ORDER  BY created_at DESC LIMIT 1
          `).get(email).catch(() => null) : null;

          if (pendingInvite) {
            // Use the invited workspace as a temporary home; the invite-accept
            // page will formally add them to workspace_members.
            workspaceId = pendingInvite.workspace_id;
          } else {
            workspaceId = await createPersonalWorkspace(userId, displayName);
            seedTrialSubscription(userId).catch(() => {});
            // Welcome email only on brand-new signup (new workspace = new user)
            if (email) {
              const appUrl = process.env.APP_URL || '';
              sendEmail('welcome', email, { name: displayName.split(' ')[0] || displayName, app_url: appUrl });
              require('./services/mailerlite').addFreeSubscriber(email, displayName).catch(() => {});
            }
          }
        }
      }

      console.log(`[auth/google] userId=${userId} workspaceId=${workspaceId} isNew=${result?.is_new_row}`);
      return done(null, {
        provider: 'google',
        id: googleId,
        user_id: userId,
        tenant_id: workspaceId,
        displayName,
        email,
        photo,
      });
    } catch (err) {
      console.error('[auth] Google OAuth strategy failed:', err.message);
      return done(err);
    }
  }));
} else {
  console.warn('[auth] Google OAuth is not configured (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
}

app.use(passport.initialize());
app.use(passport.session());

// Affiliate referral cookie — capture ?ref=sh_XXXXXXXX and store as a 30-day cookie.
app.use((req, res, next) => {
  const ref = req.query?.ref;
  if (ref && /^sh_[a-z0-9]{8}$/i.test(ref)) {
    res.cookie('sh_ref', ref, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
    affiliatesService.recordClick(ref, require('crypto').createHash('sha256').update(req.ip || '').digest('hex'))
      .catch(() => {});
  }
  next();
});

// After passport restores req.user — attach tenant_id and user_id for API routes.
// Both values are derived exclusively from the authenticated session; headers are
// never trusted for identity or tenant resolution.
app.use((req, res, next) => {
  req.tenantId = req.user?.tenant_id || null;
  req.userId   = req.user?.user_id   || null;
  next();
});

// ---------------------------------------------------------------------------
// Helper: create personal workspace + brand profile on first signup
// ---------------------------------------------------------------------------
async function createPersonalWorkspace(userId, displayName) {
  return db.transaction(async (tx) => {
    const wsRow = await tx.prepare(
      'INSERT INTO workspaces (name, created_by) VALUES (?, ?) RETURNING id'
    ).get(`${displayName}'s Workspace`, userId);
    const workspaceId = wsRow.id;
    await tx.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, now())'
    ).run(workspaceId, userId, 'owner');
    await tx.prepare(
      'INSERT INTO profiles (workspace_id, display_name, is_default, onboarding_complete) VALUES (?, ?, true, false)'
    ).run(workspaceId, displayName);
    return workspaceId;
  });
}

// ---------------------------------------------------------------------------
// requireWorkspaceMember — applied to all workspace-scoped /api/* routes.
// Verifies the session workspace exists, is not deleted, and the user is a member.
// Sets req.workspaceRole for downstream use.
// ---------------------------------------------------------------------------
async function requireWorkspaceMember(req, res, next) {
  try {
    if (!req.userId)   return res.status(401).json({ ok: false, error: 'not_authenticated' });
    if (!req.tenantId) return res.status(401).json({ ok: false, error: 'no_workspace_context' });

    const ws = await db.prepare(
      'SELECT deleted_at, created_by FROM workspaces WHERE id = ?'
    ).get(req.tenantId);
    if (!ws || ws.deleted_at) {
      // Stale session — workspace no longer valid. Force re-auth so the user
      // gets a fresh session pointing to a valid workspace.
      req.session?.destroy?.(() => {});
      res.clearCookie('scouthook.sid');
      return res.status(401).json({ ok: false, error: 'workspace_not_found' });
    }

    let member = await db.prepare(
      'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).get(req.tenantId, req.userId);

    if (!member) {
      // Self-heal: workspace creator missing from workspace_members (migration 036
      // backfill not yet applied — common in dev or after a DB restore).
      if (ws.created_by === req.userId) {
        await db.prepare(
          'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, now()) ON CONFLICT DO NOTHING'
        ).run(req.tenantId, req.userId, 'owner');
        member = { role: 'owner' };
      } else {
        return res.status(403).json({ ok: false, error: 'not_a_member' });
      }
    }

    req.workspaceRole = member.role;
    next();
  } catch (err) {
    next(err);
  }
}

function requireOwner(req, res, next) {
  if (req.workspaceRole !== 'owner') {
    return res.status(403).json({ ok: false, error: 'owner_required' });
  }
  next();
}

// requireWorkspaceActive — applied to mutating routes (POST/PUT/PATCH/DELETE) on
// workspaces that may be in grace period (soft-read-only after a plan downgrade).
// GETs are always allowed so users can still view their content.
async function requireWorkspaceActive(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  try {
    const ws = await db.prepare(
      'SELECT grace_expires_at FROM workspaces WHERE id = ?'
    ).get(req.tenantId);
    if (ws?.grace_expires_at) {
      // grace_expires_at persists until the user upgrades (clearWorkspaceGracePeriods).
      // We surface grace_expired so the frontend can show the right message:
      //   - false → "X days remaining to upgrade"
      //   - true  → "Grace period ended — upgrade to restore write access"
      const grace_expired = new Date(ws.grace_expires_at) < new Date();
      return res.status(403).json({
        ok: false,
        error: 'workspace_in_grace_period',
        grace_expires_at: ws.grace_expires_at,
        grace_expired,
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// API-only rate limit (do not apply globally — static JS/CSS/HTML each count as a request
// and 100/15min per IP breaks normal use). Tighter limits exist on /api/generate.
const apiRateLimitMax = Number(process.env.API_RATE_LIMIT_MAX || 2000);
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number.isFinite(apiRateLimitMax) && apiRateLimitMax > 0 ? apiRateLimitMax : 2000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const uid = req.userId;
    if (uid && String(uid).trim()) return `api:${String(uid).trim()}`;
    return `ip:${ipKeyGenerator(req)}`;
  },
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'rate_limited' });
  },
}));

app.get('/auth/google', (req, res, next) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.redirect('/login.html?error=google_not_configured');
  }
  if (req.query.intent === 'pro') req.session.proIntent = true;
  // Store post-login redirect so the callback can return the user to the right page
  // (e.g. invite-accept.html). Accept relative paths or same-origin full URLs only.
  if (req.query.next) {
    try {
      const appOrigin = new URL(process.env.APP_URL || 'https://app.scouthook.com').origin;
      const resolved  = new URL(req.query.next, appOrigin);
      if (resolved.origin === appOrigin) {
        req.session.postLoginRedirect = resolved.pathname + resolved.search;
      }
    } catch {
      if (req.query.next.startsWith('/')) req.session.postLoginRedirect = req.query.next;
    }
  }
  // Always show the Google account chooser so users can't accidentally log in as
  // the last Google account that was used in the browser.
  const opts = { scope: ['profile', 'email'], prompt: 'select_account' };
  if (req.query.hint) opts.loginHint = req.query.hint;
  return passport.authenticate('google', opts)(req, res, next);
});

app.get('/auth/google/callback',
  (req, res, next) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.redirect('/login.html?error=google_not_configured');
    }
    return passport.authenticate('google', { failureRedirect: '/login.html?error=oauth_failed' })(req, res, next);
  },
  async (req, res) => {
    // Track login event + capture country on first login
    try {
      await db.prepare(
        'INSERT INTO platform_events (event_type, user_id) VALUES (?, ?)'
      ).run('login', req.user.user_id);
      const geo = require('geoip-lite').lookup(req.ip);
      if (geo?.country) {
        await db.prepare(
          'UPDATE user_profiles SET country = ? WHERE user_id = ? AND country IS NULL'
        ).run(geo.country, req.user.user_id);
      }
    } catch { /* platform_events table may not exist yet */ }

    // Affiliate attribution — capture referral cookie set when the user first visited via ?ref=
    try {
      const cookies = cookie.parse(req.headers?.cookie || '');
      const refCode = cookies.sh_ref;
      if (refCode) affiliatesService.attributeReferral(req.user.user_id, refCode).catch(() => {});
    } catch { /* non-fatal */ }

    // Consume pro intent once — always clear it regardless of path taken.
    const proIntent = req.session.proIntent === true;
    delete req.session.proIntent;

    // Honour a post-login redirect BEFORE the onboarding check so that invite-accept
    // flows (and any other ?next= redirects) are never intercepted by onboarding.
    const postLoginRedirect = req.session.postLoginRedirect || null;
    delete req.session.postLoginRedirect;
    if (postLoginRedirect) return res.redirect(postLoginRedirect);

    // Route new users to the onboarding wizard; returning users go straight to dashboard.
    try {
      const userId = req.user.user_id;
      const userRow = await db.prepare(
        'SELECT onboarding_completed_at FROM user_profiles WHERE user_id = ?'
      ).get(userId);
      const hasCompletedOnboarding = !!userRow?.onboarding_completed_at;
      console.log(`[auth/google/callback] userId=${userId} workspaceId=${req.user.tenant_id} hasCompletedOnboarding=${hasCompletedOnboarding}`);

      if (!hasCompletedOnboarding) {
        // Check the active workspace profile.
        const brandProfile = await db.prepare(
          'SELECT id, onboarding_complete FROM profiles WHERE workspace_id = ? AND is_default = true'
        ).get(req.user.tenant_id);
        if (!brandProfile?.onboarding_complete) {
          // Before giving up and sending to onboarding, check if the user has ANY
          // complete workspace (e.g. their tenant_id is stale/pointing to an empty
          // auto-created workspace while their real workspace is fully set up).
          const bestWs = await db.prepare(`
            SELECT wm.workspace_id FROM workspace_members wm
            JOIN workspaces w ON w.id = wm.workspace_id
            JOIN profiles p ON p.workspace_id = w.id
            WHERE wm.user_id = ? AND p.is_default = true AND p.onboarding_complete = true
              AND w.deleted_at IS NULL
            ORDER BY wm.created_at ASC LIMIT 1
          `).get(userId);
          if (bestWs) {
            // Switch to the complete workspace and stamp onboarding as done.
            req.user.tenant_id = bestWs.workspace_id;
            await db.prepare(
              'UPDATE user_profiles SET onboarding_completed_at = now(), last_active_workspace_id = ? WHERE user_id = ?'
            ).run(bestWs.workspace_id, userId);
          } else {
            // Legacy safety: if they have posts they're a returning user whose flag was
            // never backfilled — mark both complete so they're not blocked again.
            const postCount = await db.prepare(
              'SELECT COUNT(*) AS cnt FROM generated_posts WHERE tenant_id = ?'
            ).get(req.user.tenant_id);
            if ((postCount?.cnt || 0) > 0 && brandProfile?.id) {
              await db.prepare('UPDATE profiles SET onboarding_complete = true WHERE id = ?').run(brandProfile.id);
              await db.prepare(
                'UPDATE user_profiles SET onboarding_completed_at = now() WHERE user_id = ? AND onboarding_completed_at IS NULL'
              ).run(userId);
            } else {
              return res.redirect('/onboarding.html');
            }
          }
        }
      } else {
        // Returning user. If their active workspace isn't set up yet (e.g. they just
        // created a new workspace and logged in fresh), switch them to their best
        // complete workspace so they aren't blocked.
        const wsProfile = await db.prepare(
          'SELECT onboarding_complete FROM profiles WHERE workspace_id = ? AND is_default = true'
        ).get(req.user.tenant_id);
        if (!wsProfile?.onboarding_complete) {
          const bestWs = await db.prepare(`
            SELECT wm.workspace_id FROM workspace_members wm
            JOIN workspaces w ON w.id = wm.workspace_id
            JOIN profiles p ON p.workspace_id = w.id
            WHERE wm.user_id = ? AND p.is_default = true AND p.onboarding_complete = true
              AND w.deleted_at IS NULL
            ORDER BY wm.created_at ASC LIMIT 1
          `).get(userId);
          if (bestWs) {
            req.user.tenant_id = bestWs.workspace_id;
            db.prepare(
              'UPDATE user_profiles SET last_active_workspace_id = ? WHERE user_id = ?'
            ).run(bestWs.workspace_id, userId).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error('[auth/google/callback] onboarding check failed:', err.message);
      // Non-fatal — fall through to dashboard if the check fails.
    }
    // Returning user with pro intent: open billing with auto-upgrade param.
    return res.redirect(proIntent ? '/billing.html?upgrade=1' : '/dashboard.html');
  }
);

// Email/password auth routes (signup, verify-email, login, forgot-password, reset-password)
app.use('/auth', require('./routes/email-auth'));

app.post('/auth/logout', (req, res) => {
  const finish = () => {
    res.clearCookie('scouthook.sid');
    res.json({ ok: true });
  };
  // Destroy the session entirely rather than calling req.logout().
  // Passport v0.7's req.logout() calls session.regenerate(), which creates a new
  // empty session. express-session then sets a cookie for that new session ID
  // *after* clearCookie runs, so the browser retains a dangling session cookie.
  // session.destroy() removes the session from the store and sets req.session to
  // undefined; express-session skips shouldSetCookie when req.session is absent,
  // leaving clearCookie as the only Set-Cookie header in the response.
  if (req.session) {
    req.session.destroy((err) => {
      if (err) console.error('[logout] session.destroy:', err);
      finish();
    });
  } else {
    finish();
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.isAuthenticated?.() || !req.user) return res.json({ ok: true, user: null });
  return res.json({ ok: true, user: req.user });
});


async function requireLoginHtml(req, res, next) {
  if (!req.isAuthenticated?.()) {
    const returnTo = encodeURIComponent(req.originalUrl || '/dashboard.html');
    return res.redirect(`/login.html?returnTo=${returnTo}`);
  }

  // Onboarding page itself is always reachable for authenticated users.
  // Workspace-setup is also exempt (it's its own flow).
  const exemptPaths = new Set(['/onboarding.html', '/workspace-setup.html']);
  if (exemptPaths.has(req.path)) return next();

  // Only block the app for users who have never completed first-time onboarding.
  // Returning users who create additional workspaces (onboarding_complete = false
  // on the new workspace) are never blocked — workspace-setup.html handles their
  // new workspace setup without gating the rest of the app.
  if (req.tenantId && req.userId) {
    const userRow = await db.prepare(
      'SELECT onboarding_completed_at FROM user_profiles WHERE user_id = ?'
    ).get(req.userId);
    if (!userRow?.onboarding_completed_at) {
      const profile = await db.prepare(
        'SELECT onboarding_complete FROM profiles WHERE workspace_id = ? AND is_default = true LIMIT 1'
      ).get(req.tenantId);
      if (!profile?.onboarding_complete) {
        return res.redirect('/onboarding.html');
      }
    }
  }

  return next();
}

// ---------------------------------------------------------------------------
// Health check (Render)
// ---------------------------------------------------------------------------
app.get('/healthz', async (req, res) => {
  try {
    const { db } = require('./db');
    await db.prepare('SELECT 1 AS ok').get();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(503).json({ ok: false, error: 'db_unhealthy' });
  }
});

// ---------------------------------------------------------------------------
// Routes (API before static so /api/* is never shadowed by public files)
// ---------------------------------------------------------------------------

const { requireFeature } = require('./middleware/requireFeature');

// Vault write gate — POST/PUT/PATCH/DELETE require the 'vault' feature (Solo+)
function requireVaultFeatureForWrites(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  return requireFeature('vault')(req, res, next);
}

// Workspace-scoped routes — require authenticated session + valid workspace membership
app.use('/api/profile',       requireWorkspaceMember, require('./routes/profile'));
app.use('/api/recipes',       requireWorkspaceMember, require('./routes/recipes'));
app.use('/api/generate',      requireWorkspaceMember, requireWorkspaceActive, require('./routes/generate'));
app.use('/api/visuals',           requireWorkspaceMember, require('./routes/visuals'));
app.use('/api/placid-templates', requireWorkspaceMember, require('./routes/placidTemplates'));
// /callback is exempt from workspace auth — identity comes from the state token,
// so the flow works even when the browser session has expired mid-redirect.
app.use('/api/linkedin',
  (req, res, next) => req.path === '/callback' ? next() : requireWorkspaceMember(req, res, next),
  requireWorkspaceActive,
  require('./routes/linkedin'));
app.use('/api/events',        requireWorkspaceMember, require('./routes/events'));
app.use('/api/media',         requireWorkspaceMember, require('./routes/media'));
app.use('/api/notifications', requireWorkspaceMember, require('./routes/notifications'));
app.use('/api/vault',         requireWorkspaceMember, requireWorkspaceActive, requireVaultFeatureForWrites, require('./routes/vault'));
app.use('/api/funnel',        requireWorkspaceMember, require('./routes/funnel'));
app.use('/api/checklist',     requireWorkspaceMember, require('./routes/checklist'));
app.use('/api/posts',         requireWorkspaceMember, require('./routes/performance'));
app.use('/api/workspaces',    require('./routes/workspaces'));
app.use('/api/invites',       require('./routes/invites'));
// User-scoped routes — require authenticated user, no workspace check
app.use('/api/billing',    require('./routes/billing'));
app.use('/api/feedback',   require('./routes/feedback'));
app.use('/api/support',    require('./routes/support'));
app.use('/api/affiliates', require('./routes/affiliates'));
app.use('/api',          requireWorkspaceMember, require('./routes/stats'));

// Unmatched /api/* — avoid falling through to static/HTML 404
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'api_not_found' });
});

app.use('/admin', require('./routes/admin'));
app.use('/affiliate-admin', require('./routes/affiliate-admin'));

// ---------------------------------------------------------------------------
// App entry points (send login first)
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  if (req.isAuthenticated?.()) return res.redirect('/dashboard.html');
  return res.redirect('/login.html');
});

// Protect main app HTML (session + account UI)
app.get([
  '/onboarding.html',
  '/workspace-setup.html',
  '/dashboard.html',
  '/generate.html',
  '/drafts.html',
  '/schedule.html',
  '/Published.html',
  '/post.html',
  '/Media.html',
  '/profile.html',
  '/brand.html',
  '/account.html',
  '/settings.html',
  '/billing.html',
  '/vault.html',
  '/ideas.html',
  '/members.html',
], requireLoginHtml);

// Post editor — path-based routing so postId is in the URL, not a query param
app.get('/editor/:postId', requireLoginHtml, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Serve generated visuals and uploads behind session auth.
// In local mode: sendFile from disk.  In S3 mode: stream from S3.
const storage = require('./services/storage');

function serveStoredFile(type) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).send('Unauthorized');

    // Extract bare filename — prevent path traversal
    const safePath = path.normalize(req.path).replace(/^(\.\.(\/|\\|$))+/, '');
    const filename = path.basename(safePath);
    if (!filename || filename !== safePath.replace(/^\//, '')) {
      return res.status(400).end();
    }

    // For permanent uploads, resolve the original uploader's user_id from DB so
    // any workspace member can access the file (S3 key includes the uploader's user_id).
    // Generated files are ephemeral and only accessed in the generating user's session.
    let ownerId = req.userId;
    if (type === 'uploads') {
      const row = await db.prepare(
        'SELECT user_id FROM media_files WHERE stored_name = ? AND tenant_id = ?'
      ).get(filename, req.tenantId);
      if (!row) return res.status(404).end();
      ownerId = row.user_id;
    }

    const key = storage.buildKey(req.tenantId, ownerId, type, filename);
    await storage.stream(key, res, next);
  };
}

// Serve generated visuals (PNGs, ZIPs, PDFs) — ephemeral, 24h lifetime
app.use('/files',   serveStoredFile('generated'));
// Serve permanent user uploads (never auto-cleaned)
app.use('/uploads', serveStoredFile('uploads'));

// JSON errors for API routes (Express 4 does not catch async throws without express-async-errors)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const path = req.originalUrl || req.url || '';
  if (path.startsWith('/api') || path.startsWith('/auth')) {
    console.error('[http]', req.method, path, err);
    const status = Number(err.status) || Number(err.statusCode) || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || err.code || 'server_error',
    });
  }
  return next(err);
});

// ---------------------------------------------------------------------------
// Clean generated files older than 24 hours (local backend only, runs every hour)
// In S3 mode this is handled by a bucket Lifecycle rule on the */generated/* prefix.
// ---------------------------------------------------------------------------
const fs = require('fs');
const GENERATED_DIR = path.join(__dirname, 'generated');
if (storage.getBackend() === 'local') {
  function cleanGeneratedFiles() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    try {
      for (const file of fs.readdirSync(GENERATED_DIR)) {
        if (file === '.gitkeep') continue;
        const filePath = path.join(GENERATED_DIR, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (e) { /* non-fatal */ }
  }
  if (process.env.NODE_ENV !== 'test') {
    setInterval(cleanGeneratedFiles, 60 * 60 * 1000);
  }
}

// ---------------------------------------------------------------------------
// Metrics retention — clear LinkedIn engagement data older than 90 days.
// Per LinkedIn API ToS data minimisation requirements.
// ---------------------------------------------------------------------------
async function metricsRetentionCleanup() {
  try {
    const result = await db.prepare(`
      UPDATE generated_posts
      SET    likes = NULL, comments = NULL, reactions = NULL, last_synced_at = NULL
      WHERE  last_synced_at < (now() - interval '90 days')
    `).run();
    if (result.changes > 0) {
      console.log(`[retention] Cleared metrics for ${result.changes} posts older than 90 days`);
    }
  } catch (e) {
    console.warn('[retention] Metrics cleanup failed (non-fatal):', e.message);
  }
}
// Run once on startup, then daily
if (process.env.NODE_ENV !== 'test') {
  metricsRetentionCleanup();
  setInterval(metricsRetentionCleanup, 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Email: expiring-soon — warn cancelled Pro users 3 days before access ends.
// ---------------------------------------------------------------------------
async function sendExpiringSoonEmails() {
  try {
    const { sendEmailToUser } = require('./emails');
    const appUrl = process.env.APP_URL || '';
    // Find cancelled subscriptions whose period ends in the next 3 days.
    const rows = await db.prepare(`
      SELECT user_id, current_period_end
      FROM user_subscriptions
      WHERE status = 'canceled'
        AND current_period_end IS NOT NULL
        AND current_period_end > now()
        AND current_period_end <= now() + interval '3 days'
    `).all();
    for (const row of rows) {
      const accessEnds = new Date(row.current_period_end).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const dedupKey = `expiring-soon:${row.current_period_end}`;
      sendEmailToUser(row.user_id, 'expiring-soon', { access_ends: accessEnds, app_url: appUrl },
        { dedupKey, withinHours: 7 * 24 });
    }
  } catch (e) {
    console.warn('[email-cron] expiring-soon check failed (non-fatal):', e.message);
  }
}
// Stagger slightly from metrics cleanup — run daily at a random offset from startup.
if (process.env.NODE_ENV !== 'test') {
  setTimeout(() => {
    sendExpiringSoonEmails();
    setInterval(sendExpiringSoonEmails, 24 * 60 * 60 * 1000);
  }, 5 * 60 * 1000); // first run 5 minutes after startup
}

// ---------------------------------------------------------------------------
// Email: weekly digest — sent on Sunday evenings to active users.
// ---------------------------------------------------------------------------
async function sendWeeklyDigestEmails() {
  // Only send on Sundays (getDay() === 0).
  if (new Date().getDay() !== 0) return;
  try {
    const { sendEmailToUser } = require('./emails');
    const appUrl = process.env.APP_URL || '';
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    // Users who have published at least 1 post ever (engaged users worth emailing).
    const users = await db.prepare(`
      SELECT DISTINCT user_id FROM generated_posts WHERE status = 'published'
    `).all();
    for (const { user_id } of users) {
      const [genCount, pubCount] = await Promise.all([
        // Trap 15: count across all workspaces the user is a member of
        db.prepare(`
          SELECT COUNT(*) AS n FROM generation_runs gr
          JOIN workspace_members wm ON wm.workspace_id = gr.tenant_id
          WHERE wm.user_id = ? AND gr.created_at > ?
        `).get(user_id, oneWeekAgo),
        db.prepare(`SELECT COUNT(*) AS n FROM generated_posts WHERE user_id = ? AND status = 'published' AND published_at > ?`).get(user_id, oneWeekAgo),
      ]);
      const [schedCountRow, nextSchedRow] = await Promise.all([
        db.prepare(`SELECT COUNT(*) AS n FROM scheduled_posts WHERE user_id = ? AND status = 'pending' AND scheduled_for > now()`).get(user_id),
        db.prepare(`SELECT scheduled_for FROM scheduled_posts WHERE user_id = ? AND status = 'pending' AND scheduled_for > now() ORDER BY scheduled_for ASC LIMIT 1`).get(user_id),
      ]);
      const nextPostRow = nextSchedRow
        ? `<p style="margin:0 0 20px;font-size:14px;color:#374151;">Your next post goes live on <strong>${new Date(nextSchedRow.scheduled_for).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</strong>.</p>`
        : '';
      const dedupKey = `weekly:${new Date().toISOString().slice(0, 10)}`;
      sendEmailToUser(user_id, 'weekly-digest', {
        posts_generated: String(genCount?.n || 0),
        posts_published: String(pubCount?.n || 0),
        posts_scheduled: String(schedCountRow?.n || 0),
        next_post_row: nextPostRow,
        app_url: appUrl,
      }, { dedupKey, withinHours: 6 * 24 });
    }
  } catch (e) {
    console.warn('[email-cron] weekly digest failed (non-fatal):', e.message);
  }
}
// Check once every 6 hours — the Sunday guard inside ensures it only sends on Sunday.
if (process.env.NODE_ENV !== 'test') {
  setInterval(sendWeeklyDigestEmails, 6 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Billing: daily subscription re-sync for expired/stale subscriptions.
// Re-fetches plan state from Paddle for subscriptions whose current_period_end
// has passed but were not updated in the last 12 hours (missed renewal events).
// Runs enforceWorkspaceLimitGrace after each sync so plan changes propagate.
// ---------------------------------------------------------------------------
async function syncExpiredSubscriptions() {
  try {
    const { forceSyncSubscriptionForUser } = require('./services/subscription');
    const { enforceWorkspaceLimitGrace }   = require('./lib/workspaceUtils');

    const stale = await db.prepare(`
      SELECT user_id FROM user_subscriptions
      WHERE status IN ('active', 'trialing', 'canceled')
        AND current_period_end IS NOT NULL
        AND current_period_end < now()
        AND updated_at < now() - interval '12 hours'
    `).all();

    for (const row of stale) {
      try {
        const result = await forceSyncSubscriptionForUser(row.user_id);
        if (result) {
          const sub = await db.prepare(
            'SELECT plan, extra_workspaces FROM user_subscriptions WHERE user_id = ?'
          ).get(row.user_id);
          await enforceWorkspaceLimitGrace(row.user_id, sub?.plan ?? 'free', sub?.extra_workspaces ?? 0);
        }
      } catch (err) {
        console.error('[billing-sync-cron] failed for', row.user_id, err.message);
      }
    }
  } catch (e) {
    console.warn('[billing-sync-cron] failed (non-fatal):', e.message);
  }
}
// Run 15 minutes after startup so Paddle SDK is warmed up, then daily.
if (process.env.NODE_ENV !== 'test') {
  setTimeout(() => {
    syncExpiredSubscriptions();
    setInterval(syncExpiredSubscriptions, 24 * 60 * 60 * 1000);
  }, 15 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Email: trial expiry — warn trialing users 3 days before trial ends.
// ---------------------------------------------------------------------------
async function sendTrialExpiryEmails() {
  try {
    const users = await db.prepare(`
      SELECT up.user_id, up.email, up.display_name, us.trial_ends_at
      FROM user_subscriptions us
      JOIN user_profiles up ON up.user_id = us.user_id
      WHERE us.status = 'trialing'
        AND us.trial_ends_at BETWEEN now() + INTERVAL '2 days' AND now() + INTERVAL '3 days'
    `).all();
    for (const u of users) {
      const trialEndDate = new Date(u.trial_ends_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
      sendEmailToUser(u.user_id, 'trial-expiry', {
        display_name: u.display_name || 'there',
        trial_end_date: trialEndDate,
        days_left: '3',
        upgrade_url: `${process.env.APP_URL || 'https://app.scouthook.com'}/billing.html`,
      }, { dedupKey: `trial_expiry:${u.user_id}`, withinHours: 168 }).catch(() => {});
    }
  } catch (e) {
    console.warn('[email-cron] trial-expiry check failed (non-fatal):', e.message);
  }
}
// Runs daily — offset from other crons via immediate + interval pattern.
if (process.env.NODE_ENV !== 'test') {
  setTimeout(() => {
    sendTrialExpiryEmails();
    setInterval(sendTrialExpiryEmails, 24 * 60 * 60 * 1000);
  }, 20 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Email: LinkedIn token expiry — warn workspace members 7 days before expiry.
// ---------------------------------------------------------------------------
async function sendLinkedInTokenExpiryWarnings() {
  try {
    const { sendEmailToUser } = require('./emails');
    const rows = await db.prepare(`
      SELECT lc.workspace_id, lc.display_name, lc.expires_at,
             wm.user_id
      FROM linkedin_connections lc
      JOIN workspace_members wm ON wm.workspace_id = lc.workspace_id
      WHERE lc.is_default = true
        AND lc.expires_at BETWEEN now() + INTERVAL '6 days' AND now() + INTERVAL '7 days'
    `).all();
    for (const row of rows) {
      const daysLeft = Math.ceil((new Date(row.expires_at) - Date.now()) / 86400000);
      sendEmailToUser(row.user_id, 'linkedin-token-expiring-soon', {
        connection_name: row.display_name || 'LinkedIn',
        days_left:       String(daysLeft),
        reconnect_url:   `${process.env.APP_URL || 'https://app.scouthook.com'}/account.html`,
      }, { dedupKey: `linkedin_expiry_${row.workspace_id}`, withinHours: 168 }).catch(() => {});
    }
  } catch (e) {
    console.warn('[email-cron] linkedin-token-expiry check failed (non-fatal):', e.message);
  }
}
// Runs daily — offset 30 min from startup to stagger with other crons.
if (process.env.NODE_ENV !== 'test') {
  setTimeout(() => {
    sendLinkedInTokenExpiryWarnings();
    setInterval(sendLinkedInTokenExpiryWarnings, 24 * 60 * 60 * 1000);
  }, 30 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Workspace purge — hard-delete workspaces + clean up stale expired invites daily.
// ---------------------------------------------------------------------------
const { purgeExpiredWorkspaces, purgeExpiredInvites } = require('./workers/workspacePurge');
if (process.env.NODE_ENV !== 'test') {
  setTimeout(() => {
    purgeExpiredWorkspaces();
    purgeExpiredInvites();
    setInterval(purgeExpiredWorkspaces, 24 * 60 * 60 * 1000);
    setInterval(purgeExpiredInvites, 24 * 60 * 60 * 1000);
  }, 25 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Scheduler (BullMQ worker — only starts if Redis is configured)
// ---------------------------------------------------------------------------

const { initScheduler } = require('./services/scheduler');
initScheduler().catch(err => {
  console.warn('[scheduler] Redis not configured or unavailable — scheduling disabled:', err.message);
});

const { initRedis } = require('./services/redis');
initRedis().catch(err => {
  console.warn('[redis] shared client init failed:', err.message);
});

// ---------------------------------------------------------------------------
// Affiliate commission reconciliation (daily Paddle API polling)
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV !== 'test') {
  scheduleReconciler();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

module.exports = { app };

const PORT = process.env.PORT || 4000;
if (require.main === module) (async () => {
  try {
    await runSeed();
  } catch (e) {
    console.warn('[seed] skipped/failed:', e.message);
  }

  const httpServer = app.listen(PORT, () => {
    console.log(`[scouthook] Server running on http://localhost:${PORT}`);
    console.log(`[scouthook] Admin UI: http://localhost:${PORT}/admin.html`);
  });

  // Graceful shutdown — drain in-flight requests and close the BullMQ worker
  // before the process exits. Render (and most PaaS hosts) send SIGTERM on deploy.
  async function shutdown(signal) {
    console.log(`[scouthook] ${signal} received — shutting down gracefully`);
    httpServer.close(() => console.log('[scouthook] HTTP server closed'));
    try {
      const { getWorker } = require('./services/scheduler');
      const worker = getWorker();
      if (worker) await worker.close();
    } catch { /* scheduler may not be running */ }
    try {
      const { getRedis } = require('./services/redis');
      const redis = getRedis();
      if (redis) await redis.quit();
    } catch { /* non-fatal */ }
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
})();

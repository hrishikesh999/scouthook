/* pricing-modal.js — Upgrade overlay for ScoutHook
 * Exposes window.PricingModal = { open, close }
 * Included on all protected pages via account-bar.js
 */
(function () {
  'use strict';

  if (window.PricingModal) return;

  const PENDING_PADDLE_TXN_KEY = 'scouthook_pending_paddle_txn';

  function checkoutCompletedTransactionId(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const d = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    const tid =
      d.transaction_id ||
      d.transactionId ||
      (d.transaction && typeof d.transaction === 'object' ? d.transaction.id : null) ||
      null;
    if (!tid || typeof tid !== 'string') return null;
    return tid.startsWith('txn_') ? tid : null;
  }

  // ── Feature label map ─────────────────────────────────────────────────────
  const FEATURE_LABELS = {
    scheduling:                 'Post scheduling',
    vault:                      'Knowledge Vault',
    team_members:               'Team members',
    company_pages:              'Company pages',
    carousel:                   'Carousel visuals',
    extra_workspaces:           'Additional workspaces',
  };

  // ── Inject styles ─────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
  #pm-overlay {
    position: fixed;
    inset: 0;
    z-index: 900;
    background: rgba(9,9,11,0.6);
    backdrop-filter: blur(3px);
    display: none;
    align-items: flex-start;
    justify-content: center;
    padding: 32px 16px;
    overflow-y: auto;
  }
  #pm-overlay.visible { display: flex; }

  /* Frosted instead of the usual dark scrim, used when the modal is the
     free-cap ask: the post the author just wrote stays legible behind it,
     because that post is the argument for upgrading. Everywhere else the
     scrim stays dark, where readability of the modal is all that matters. */
  #pm-overlay.pm-glass {
    background: rgba(255, 255, 255, 0.42);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
  }
  @media (prefers-reduced-transparency: reduce) {
    #pm-overlay.pm-glass { backdrop-filter: none; -webkit-backdrop-filter: none; background: rgba(255,255,255,0.9); }
  }

  #pm-modal {
    background: var(--bg-surface, #fff);
    border: 1px solid var(--border, #E4E4E7);
    border-radius: 20px;
    width: 100%;
    max-width: 640px;
    position: relative;
    box-shadow: 0 24px 80px rgba(0,0,0,0.28), 0 0 0 1px rgba(0,0,0,0.04);
    margin: 0 auto;
    overflow: hidden;
  }

  /* Accent bar at the top of the modal */
  #pm-modal::before {
    content: '';
    display: block;
    height: 4px;
    background: linear-gradient(90deg, #4f46e5 0%, #0D9488 100%);
  }

  #pm-modal-body {
    padding: 40px 40px 36px;
  }

  #pm-close {
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 2;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted, #71717A);
    padding: 8px;
    border-radius: 8px;
    line-height: 1;
    display: flex;
    align-items: center;
    transition: background 0.15s, color 0.15s;
  }
  #pm-close:hover { background: var(--bg-pill, #F4F4F5); color: var(--text-heading, #09090B); }
  #pm-close svg { pointer-events: none; }

  #pm-header { text-align: center; margin-bottom: 28px; }
  #pm-header-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: #4f46e5;
    background: rgba(79,70,229,0.08);
    border: 1px solid rgba(79,70,229,0.18);
    border-radius: 20px;
    padding: 4px 12px;
    margin-bottom: 14px;
  }
  #pm-header h2 {
    font-size: 26px;
    font-weight: 800;
    color: var(--text-heading, #09090B);
    margin: 0 0 8px;
    letter-spacing: -0.4px;
    line-height: 1.25;
  }
  #pm-header p {
    font-size: 15px;
    color: var(--text-muted, #71717A);
    margin: 0;
    line-height: 1.5;
  }

  #pm-context-banner {
    display: none;
    background: rgba(79,70,229,0.06);
    border: 1px solid rgba(79,70,229,0.18);
    border-radius: 10px;
    padding: 11px 16px;
    font-size: 13px;
    font-weight: 500;
    color: #4338CA;
    text-align: center;
    margin-bottom: 20px;
  }
  #pm-context-banner.visible { display: block; }

  /* Feature highlights grid above the plan card */
  .pm-cards {
    display: grid;
    /* auto-fit, not a fixed two columns: before PADDLE_PRICE_ID_DELUXE is set
       only Pro is purchasable, and a lone card should fill the row rather than
       sit beside an empty column. */
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 14px;
    align-items: start;
  }
  .pm-rec {
    position: absolute; top: 14px; right: 14px;
    background: #ecfdf5; color: #0D9488;
    font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    padding: 3px 10px; border-radius: 99px;
  }
  .pm-tagline { font-size: 12px; color: var(--text-muted, #71717A); margin-top: 6px; }
  .pm-card-features { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
  .pm-card-features li {
    display: flex; gap: 8px; align-items: flex-start;
    font-size: 13px; line-height: 1.45; color: var(--text-heading, #18181B);
  }
  .pm-card-features li svg { color: #10B981; flex-shrink: 0; margin-top: 3px; }
  @media (max-width: 600px) {
    #pm-modal-body { padding: 32px 20px 28px; }
    .pm-cards { grid-template-columns: 1fr; }
    #pm-header h2 { font-size: 22px; }
  }

  .pm-card {
    position: relative;
    border: 1px solid var(--border, #E4E4E7);
    border-radius: 14px;
    padding: 24px 24px 26px;
    background: var(--bg-surface, #fff);
    display: flex;
    flex-direction: column;
    gap: 20px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .pm-card.pm-featured {
    border-color: #0D9488;
    box-shadow: 0 0 0 3px rgba(13,148,136,0.1);
    background: linear-gradient(135deg, rgba(13,148,136,0.02) 0%, #fff 60%);
  }

  .pm-card-top { /* price block */ }

  .pm-plan-name {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted, #71717A);
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .pm-plan-name.pm-pro { color: #0D9488; }

  .pm-current-chip {
    font-size: 10px;
    font-weight: 600;
    background: var(--bg-pill, #F4F4F5);
    color: var(--text-muted, #71717A);
    border-radius: 20px;
    padding: 2px 8px;
    letter-spacing: 0;
    text-transform: none;
  }
  .pm-price {
    font-size: 40px;
    font-weight: 900;
    color: var(--text-heading, #09090B);
    line-height: 1;
    margin-bottom: 3px;
    letter-spacing: -1px;
  }
  .pm-price sup { font-size: 18px; font-weight: 700; vertical-align: super; letter-spacing: 0; }
  .pm-period {
    font-size: 13px;
    color: var(--text-muted, #71717A);
    margin-bottom: 20px;
    font-weight: 500;
  }

  .pm-cta {
    display: block;
    width: 100%;
    padding: 13px 18px;
    border-radius: 11px;
    font-size: 15px;
    font-weight: 700;
    text-align: center;
    cursor: pointer;
    border: none;
    transition: background 0.15s, opacity 0.15s, transform 0.1s;
    letter-spacing: -0.1px;
  }
  .pm-cta:active:not(:disabled) { transform: scale(0.98); }
  /* Defined after .pm-cta, which sets border:none — and with both classes in
     the selector, so the border survives regardless of source order. */
  .pm-cta.pm-cta-outline {
    background: var(--bg-surface, #fff);
    color: #0D9488;
    border: 1.5px solid #0D9488;
  }
  .pm-cta.pm-cta-outline:hover:not(:disabled) { background: #f0fdfa; }
  .pm-cta-primary {
    background: linear-gradient(135deg, #0D9488 0%, #0F766E 100%);
    color: #fff;
    box-shadow: 0 4px 14px rgba(13,148,136,0.35);
  }
  .pm-cta-primary:hover:not(:disabled) {
    background: linear-gradient(135deg, #0F9F92 0%, #115E59 100%);
    box-shadow: 0 6px 20px rgba(13,148,136,0.4);
  }
  .pm-cta-primary:disabled { opacity: 0.55; cursor: default; box-shadow: none; }

  .pm-cta-muted {
    background: var(--bg-pill, #F4F4F5);
    color: var(--text-muted, #71717A);
  }
  .pm-cta-muted:disabled { cursor: default; opacity: 0.7; }

  .pm-guarantee {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin-top: 14px;
    font-size: 12px;
    color: var(--text-muted, #71717A);
  }
  .pm-guarantee svg { color: #10B981; flex-shrink: 0; }

  .pm-error {
    margin-top: 10px;
    font-size: 12px;
    color: var(--score-fail, #DC2626);
    text-align: center;
    display: none;
  }
  `;
  document.head.appendChild(style);

  // ── Inject HTML ───────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'pm-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Upgrade plan');
  overlay.innerHTML = `
    <div id="pm-modal">
      <button id="pm-close" aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>

      <div id="pm-modal-body">
        <div id="pm-header">
          <div id="pm-header-badge">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            <span id="pm-badge-text">ScoutHook plans</span>
          </div>
          <h2 id="pm-title"></h2>
          <p id="pm-subtitle"></p>
        </div>

        <div id="pm-context-banner"></div>

        <!-- Filled by renderPlanCards() from /api/billing/config, so the plans
             offered here are exactly the plans with a configured Paddle price. -->
        <div class="pm-cards" id="pm-cards"></div>

        <div class="pm-guarantee">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Secure checkout via Paddle &middot; Cancel anytime
        </div>
      </div><!-- /pm-modal-body -->
    </div><!-- /pm-modal -->
  `;
  document.body.appendChild(overlay);

  // ── State ──────────────────────────────────────────────────────────────────
  let paddleConfig = null;
  let configLoaded = false;
  let currentPlan  = 'expired';  // set on open() after subscription fetch

  // ── DOM refs ───────────────────────────────────────────────────────────────
  function $id(id) { return document.getElementById(id); }

  // ── Paddle.js lazy loader ─────────────────────────────────────────────────
  let paddleInitialized = false;
  let paddleInitPromise = null;

  function loadPaddleScript() {
    return new Promise((resolve, reject) => {
      if (window.Paddle) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function ensurePaddle(clientToken, env) {
    // Check both the local flag and the shared global — workspace-modal may have
    // initialized Paddle first on pages where it loaded before pricing-modal.
    if (paddleInitialized || window._paddleInitialized) return;
    if (paddleInitPromise) { await paddleInitPromise; return; }
    paddleInitPromise = (async () => {
      await loadPaddleScript();
      if (env !== 'production') window.Paddle.Environment.set('sandbox');
      window.Paddle.Initialize({
        token: clientToken,
        eventCallback: function (data) {
          // Allow other modules (e.g. workspace-modal) to claim this event first.
          // A handler returns true to signal it owns the event; default behaviour is skipped.
          const claimed = (window._paddleEventBus || []).some(function (h) {
            try { return h(data) === true; } catch { return false; }
          });
          if (claimed) return;

          if (data.name !== 'checkout.completed') return;
          const tid = checkoutCompletedTransactionId(data);
          try { if (tid) sessionStorage.setItem(PENDING_PADDLE_TXN_KEY, tid); } catch { /* private mode */ }
          // Bust cached subscription so initFreeTierBanner() and renderSidebarUpgrade()
          // don't serve a stale trial_expired:true response after the user upgrades.
          if (window.cachedFetch) cachedFetch.bust('/api/billing/subscription');
          fetch('/api/billing/sync', {
            method: 'POST',
            credentials: 'same-origin',
            keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transactionId: tid }),
          }).catch(() => {});
          try {
            window.top.location.href = '/billing.html?checkout=success';
          } catch {
            window.location.href = '/billing.html?checkout=success';
          }
        },
      });
      paddleInitialized = true;
      window._paddleInitialized = true; // shared flag so workspace-modal skips re-init
    })();
    await paddleInitPromise;
  }

  // ── Entry-point copy ───────────────────────────────────────────────────────
  /**
   * The modal is opened from several places, and the header should say why.
   * DEFAULT is the generic pitch; 'free_cap' is the moment the author has just
   * spent their last free post, where the specific thing that happened is far
   * more persuasive than a feature list.
   */
  const DEFAULT_HEADER = {
    badge: 'ScoutHook plans',
    title: 'Unlock the full ScoutHook experience',
    subtitle: 'Everything you need to build authority and grow on LinkedIn.',
  };

  const CONTEXT_HEADERS = {
    free_cap: {
      badge: 'Free posts used',
      title: 'The hard part is already behind you.',
      subtitle: "What stops most people isn't ideas, it's consistency. Your ideal client is already there on LinkedIn. The question is — will you get the next post out?",
      banner: 'This post is yours either way — close this to edit, schedule or publish it.',
      glass: true,
    },
  };

  // ── Plan copy ──────────────────────────────────────────────────────────────
  /**
   * What each plan says for itself. The single source for both this modal and
   * the editor's free-tier overlay, which reads it via PricingModal.planCopy —
   * two copies of a pricing table drift, and the one that drifts is always the
   * one the customer is looking at.
   *
   * Prices, labels and taglines are NOT here: those come from
   * /api/billing/config, which reflects what Paddle is configured to charge.
   * A price printed here and changed there shows one figure and bills another.
   */
  const PLAN_COPY = {
    pro: {
      // The filled green button. Deliberately not the same flag as
      // `recommended`: the badge marks the plan we point people towards, the
      // button marks the one we want most to be easy to say yes to, and here
      // those are different plans.
      primaryCta: true,
      features: [
        'Unlimited posts — never hit a cap',
        'Repurpose your blogs, PDFs and decks',
        'Content coach with 10+ post types',
        'Schedule a month in one sitting',
        'Unlimited on-brand visuals',
        'One workspace',
      ],
    },
    deluxe: {
      recommended: true,
      features: [
        'Everything in Pro, plus:',
        'Five workspaces instead of one',
        'Manage up to 5 LinkedIn accounts',
        'Team members',
        'A separate voice, vault and schedule per brand',
        'One subscription across all of them',
      ],
    },
  };

  function esc(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  const TICK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

  /** Render one card per purchasable plan, then wire each card's button. */
  function renderPlanCards(plans) {
    const wrap = $id('pm-cards');
    if (!wrap) return;

    if (!plans || !plans.length) {
      // No configured price means nothing can be bought. Saying so beats a
      // button that opens a checkout we cannot complete.
      wrap.innerHTML = '<div class="pm-error" style="display:block">Plans are unavailable right now. Please try again shortly.</div>';
      return;
    }

    wrap.innerHTML = plans.map(function (p) {
      const copy = PLAN_COPY[p.plan] || { features: [] };
      const feats = copy.features.map(function (f) {
        return '<li>' + TICK_SVG + '<span>' + esc(f) + '</span></li>';
      }).join('');
      return '' +
        '<div class="pm-card' + (copy.recommended ? ' pm-featured' : '') + '" data-plan-card="' + esc(p.plan) + '">' +
          (copy.recommended ? '<span class="pm-rec">Recommended</span>' : '') +
          '<div class="pm-card-top">' +
            '<div class="pm-plan-name pm-pro">' + esc(p.label) + ' plan' +
              '<span class="pm-current-chip" data-chip="' + esc(p.plan) + '" style="display:none">Current plan</span>' +
            '</div>' +
            '<div class="pm-price"><sup>$</sup>' + esc(String(p.price)) + '</div>' +
            '<div class="pm-period">per month · cancel anytime</div>' +
            (p.tagline ? '<div class="pm-tagline">' + esc(p.tagline) + '</div>' : '') +
          '</div>' +
          '<button class="pm-cta ' + (copy.primaryCta ? 'pm-cta-primary' : 'pm-cta-outline') + '" data-plan-btn="' + esc(p.plan) + '" type="button">Choose ' + esc(p.label) + '</button>' +
          '<ul class="pm-card-features">' + feats + '</ul>' +
          '<div class="pm-error" data-error="' + esc(p.plan) + '"></div>' +
        '</div>';
    }).join('');

    wrap.querySelectorAll('[data-plan-btn]').forEach(function (btn) {
      btn.addEventListener('click', function () { onPlanButton(btn); });
    });
  }

  /** Checkout for a plan the user is not on; billing portal for the one they are. */
  async function onPlanButton(btn) {
    if (btn.disabled) return;
    const plan = btn.dataset.planBtn;
    const errorEl = $id('pm-cards').querySelector('[data-error="' + plan + '"]');

    if (currentPlan === plan) {
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = 'Loading…';
      try {
        const r = await fetch('/api/billing/portal');
        const d = await r.json();
        if (d.portalUrl) { window.location.href = d.portalUrl; return; }
      } catch { /* fall through to the error below */ }
      if (errorEl) { errorEl.textContent = 'Unable to open billing portal.'; errorEl.style.display = ''; }
      btn.disabled = false;
      btn.textContent = orig;
      return;
    }

    startPlanCheckout(plan, btn, errorEl);
  }

  // ── Config fetch ───────────────────────────────────────────────────────────
  async function loadConfig() {
    if (configLoaded) return;
    try {
      const r = await fetch('/api/billing/config');
      if (!r.ok) return;
      const d = await r.json();
      paddleConfig = d;
      configLoaded = true;
    } catch { /* no-op */ }
  }

  // ── Close ──────────────────────────────────────────────────────────────────
  function close() {
    overlay.classList.remove('visible');
    document.body.style.overflow = '';
  }

  $id('pm-close').addEventListener('click', close);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay.classList.contains('visible')) close();
  });

  // ── Checkout launcher ─────────────────────────────────────────────────────
  async function startPlanCheckout(plan, btn, errorEl) {
    console.log('[checkout] step 1 — loading config, plan=' + plan);
    if (!paddleConfig) await loadConfig();

    console.log('[checkout] step 2 — config loaded:', JSON.stringify({
      hasClientToken: !!paddleConfig?.clientToken,
      env: paddleConfig?.env,
      priceIdMonthly: paddleConfig?.priceIdMonthly,
    }));

    if (!paddleConfig?.clientToken) {
      const msg = 'Checkout unavailable: PADDLE_CLIENT_TOKEN is not configured.';
      console.error('[checkout]', msg);
      if (window.toast) window.toast.error(msg);
      else if (errorEl) { errorEl.textContent = msg; errorEl.style.display = ''; }
      return;
    }

    // btn is optional — callers outside this modal (the editor's upgrade overlay)
    // may have no button to put in a loading state.
    if (btn) btn.disabled = true;
    const origText  = btn ? btn.textContent : '';
    if (btn) btn.textContent = 'Loading…';
    if (errorEl) errorEl.style.display = 'none';

    try {
      console.log('[checkout] step 3 — calling /api/billing/upgrade');
      const upgradeRes = await fetch('/api/billing/upgrade', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      const upgradeData = await upgradeRes.json();
      console.log('[checkout] step 4 — upgrade response:', JSON.stringify(upgradeData));

      if (!upgradeRes.ok || !upgradeData.priceId) {
        throw new Error(upgradeData.error || 'price_not_configured');
      }

      console.log('[checkout] step 5 — initialising Paddle.js');
      await ensurePaddle(paddleConfig.clientToken, paddleConfig.env);
      console.log('[checkout] step 6 — Paddle ready, opening checkout priceId=' + upgradeData.priceId);

      let userId = null;
      try { userId = (await window.scouthookAuthReady)?.user?.user_id ?? null; } catch { /* no-op */ }
      if (!userId) { try { userId = localStorage.getItem('scouthook_uid'); } catch { /* no-op */ } }

      // Close the pricing modal before opening Paddle Checkout — otherwise
      // the modal overlay (z-index 900) sits on top of the Paddle iframe.
      close();

      window.Paddle.Checkout.open({
        items: [{ priceId: upgradeData.priceId, quantity: 1 }],
        customData: { ...(userId ? { userId } : {}), plan },
        settings: {
          displayMode: 'overlay',
          successUrl: window.location.origin + '/billing.html?checkout=success',
        },
      });

      console.log('[checkout] step 7 — Paddle.Checkout.open() called successfully');
      if (btn) { btn.disabled = false; btn.textContent = origText; }
    } catch (err) {
      console.error('[checkout] FAILED at step — error:', err);
      const msg = err.message === 'price_not_configured'
        ? 'Pricing not yet configured. Please contact support.'
        : (err.message || 'Unable to start checkout. Please try again.');
      if (window.toast) {
        window.toast.error(msg);
      } else if (errorEl) {
        errorEl.textContent = msg;
        errorEl.style.display = '';
      }
      if (btn) { btn.disabled = false; btn.textContent = origText; }
    }
  }

  // ── open(options) ──────────────────────────────────────────────────────────
  async function open(options) {
    const opts    = (options && typeof options === 'object') ? options : {};
    const feature = opts.feature || null;
    const header  = CONTEXT_HEADERS[opts.context] || DEFAULT_HEADER;

    // — Header copy for this entry point. Always reassigned, never only set on
    //   the branch that needs it: the modal is a singleton, so copy left over
    //   from a previous open would greet the next caller.
    $id('pm-badge-text').textContent = opts.badge || header.badge;
    $id('pm-title').textContent      = header.title;
    $id('pm-subtitle').textContent   = header.subtitle;
    overlay.classList.toggle('pm-glass', !!header.glass);

    // — Context banner
    const bannerEl = $id('pm-context-banner');
    bannerEl.classList.remove('visible');
    if (header.banner) {
      bannerEl.textContent = header.banner;
      bannerEl.classList.add('visible');
    } else if (feature && FEATURE_LABELS[feature]) {
      bannerEl.textContent = `${FEATURE_LABELS[feature]} requires the Pro plan.`;
      bannerEl.classList.add('visible');
    }

    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';

    // — Load config and subscription in parallel
    const [, subRes] = await Promise.allSettled([
      loadConfig(),
      fetch('/api/billing/subscription').then(r => r.json()).catch(() => null),
    ]);

    const sub = (subRes.status === 'fulfilled' ? subRes.value : null) || {};
    // Trial users should always go through checkout, not the management portal —
    // even if they have a stale price_id from a prior cancelled subscription.
    // Exclude expired app-level trials so they're treated as Free, not active trial.
    const isAppTrial = sub.status === 'trialing' && !sub.trial_expired;
    currentPlan = isAppTrial ? 'expired' : (sub.plan || 'expired');

    // — Cards come from config, so only plans with a configured Paddle price
    //   are shown. Rendered after the fetches so the current-plan state below
    //   has something to mark.
    renderPlanCards(paddleConfig?.plans || []);

    // — Mark the plan they are already on: its button manages the subscription
    //   rather than starting a second checkout.
    const cardsEl = $id('pm-cards');
    const chip = cardsEl?.querySelector('[data-chip="' + currentPlan + '"]');
    if (chip) chip.style.display = '';
    const ownBtn = cardsEl?.querySelector('[data-plan-btn="' + currentPlan + '"]');
    if (ownBtn) ownBtn.textContent = 'Manage subscription';
  }

  // ── Post-checkout sync on success redirect ─────────────────────────────────
  if (window.location.search.includes('checkout=success')) {
    const _params = new URLSearchParams(window.location.search);
    let _txnId = _params.get('_ptxn') || null;
    if (!_txnId) {
      try { _txnId = sessionStorage.getItem(PENDING_PADDLE_TXN_KEY); } catch { /* no-op */ }
    }
    fetch('/api/billing/sync', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId: _txnId }),
    }).then(function (r) {
      if (r.ok) { try { sessionStorage.removeItem(PENDING_PADDLE_TXN_KEY); } catch { /* no-op */ } }
    }).catch(() => {});
  }

  // ── Expose globally ────────────────────────────────────────────────────────
  /**
   * Start Paddle checkout for a plan directly, with no modal in between.
   *
   * The upgrade overlay in the editor already shows the plans and their prices,
   * so routing it through open() would make the user pick a plan twice — and the
   * modal only knows how to present Pro. startPlanCheckout has always taken a
   * plan; it simply had no caller outside this file.
   */
  async function checkout(plan, btn) {
    return startPlanCheckout(plan, btn || null, null);
  }

  window.PricingModal = { open, close, checkout, planCopy: PLAN_COPY };
})();

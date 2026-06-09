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
    vault:                      'Content Vault',
    team_members:               'Team members',
    company_pages:              'Company pages',
    multiple_linkedin_accounts: 'Multiple LinkedIn accounts',
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
    background: rgba(9,9,11,0.5);
    display: none;
    align-items: flex-start;
    justify-content: center;
    padding: 24px;
    overflow-y: auto;
  }
  #pm-overlay.visible { display: flex; }

  #pm-modal {
    background: var(--bg-surface, #fff);
    border: 1px solid var(--border, #E4E4E7);
    border-radius: 16px;
    width: 100%;
    max-width: 480px;
    position: relative;
    box-shadow: 0 8px 40px rgba(0,0,0,0.22);
    margin: 0 auto;
  }

  #pm-modal-body {
    padding: 48px 32px 40px;
  }

  #pm-close {
    position: absolute;
    top: 12px;
    right: 16px;
    z-index: 2;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted, #71717A);
    padding: 8px;
    border-radius: 6px;
    line-height: 1;
    display: flex;
    align-items: center;
  }
  #pm-close:hover { background: var(--bg-pill, #F4F4F5); }
  #pm-close svg { pointer-events: none; }

  #pm-header { text-align: center; margin-bottom: 20px; }
  #pm-header h2 {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-heading, #09090B);
    margin: 0 0 6px;
  }
  #pm-header p {
    font-size: 14px;
    color: var(--text-muted, #71717A);
    margin: 0;
  }

  #pm-context-banner {
    display: none;
    background: var(--bg-pill, #F4F4F5);
    border: 1px solid var(--border, #E4E4E7);
    border-radius: 8px;
    padding: 10px 16px;
    font-size: 13px;
    color: var(--text-body, #27272A);
    text-align: center;
    margin-bottom: 20px;
  }
  #pm-context-banner.visible { display: block; }

  .pm-cards {
    display: grid;
    grid-template-columns: 1fr;
    gap: 14px;
  }
  @media (max-width: 540px) {
    #pm-modal-body { padding: 48px 16px 28px; }
  }

  .pm-card {
    border: 1px solid var(--border, #E4E4E7);
    border-radius: 12px;
    padding: 20px 18px 22px;
    background: var(--bg-surface, #fff);
    display: flex;
    flex-direction: column;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .pm-card.pm-featured {
    border-color: var(--brand, #0F766E);
    box-shadow: 0 0 0 3px rgba(15,118,110,0.1);
  }

  .pm-plan-name {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted, #71717A);
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .pm-plan-name.pm-pro  { color: var(--brand, #0F766E); }

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
    font-size: 32px;
    font-weight: 800;
    color: var(--text-heading, #09090B);
    line-height: 1;
    margin-bottom: 4px;
  }
  .pm-price sup { font-size: 14px; font-weight: 700; vertical-align: super; }
  .pm-period {
    font-size: 12px;
    color: var(--text-muted, #71717A);
    margin-bottom: 16px;
  }

  .pm-divider {
    border: none;
    border-top: 1px solid var(--border-divider, #F4F4F5);
    margin: 14px 0;
  }

  .pm-features {
    list-style: none;
    padding: 0;
    margin: 0 0 18px;
    flex: 1;
  }
  .pm-features li {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    font-size: 12.5px;
    color: var(--text-body, #000);
    padding: 3px 0;
    line-height: 1.4;
  }
  .pm-features li svg { flex-shrink: 0; margin-top: 2px; }
  .pm-feature-excluded { color: var(--text-muted, #A1A1AA) !important; }

  .pm-cta {
    display: block;
    width: 100%;
    padding: 10px 14px;
    border-radius: 9px;
    font-size: 13px;
    font-weight: 600;
    text-align: center;
    cursor: pointer;
    border: none;
    transition: background 0.15s, opacity 0.15s;
    margin-top: auto;
  }
  .pm-cta-primary {
    background: var(--brand, #0F766E);
    color: #fff;
  }
  .pm-cta-primary:hover:not(:disabled) { background: var(--brand-hover, #115E59); }
  .pm-cta-primary:disabled { opacity: 0.55; cursor: default; }

  .pm-cta-muted {
    background: var(--bg-pill, #F4F4F5);
    color: var(--text-muted, #71717A);
  }
  .pm-cta-muted:disabled { cursor: default; opacity: 0.7; }

  .pm-error {
    margin-top: 8px;
    font-size: 12px;
    color: var(--score-fail, #DC2626);
    text-align: center;
    display: none;
  }
  `;
  document.head.appendChild(style);

  // ── SVG helpers ───────────────────────────────────────────────────────────
  const CHECK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
  const CROSS = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#A1A1AA" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  function feat(ok, text) {
    return `<li class="${ok ? '' : 'pm-feature-excluded'}">${ok ? CHECK : CROSS}${text}</li>`;
  }

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
          <h2 id="pm-title">Simple, transparent pricing</h2>
          <p id="pm-subtitle">Start free. Upgrade when you're ready to grow.</p>
        </div>

        <div id="pm-context-banner"></div>

        <div class="pm-cards">

          <!-- Pro -->
          <div class="pm-card pm-featured" id="pm-card-pro">
            <div class="pm-plan-name pm-pro">
              Pro
              <span class="pm-current-chip" id="pm-pro-chip" style="display:none">Current plan</span>
            </div>
            <div class="pm-price"><sup>$</sup><span id="pm-pro-price">27</span></div>
            <div class="pm-period">/ month</div>
            <hr class="pm-divider">
            <ul class="pm-features">
              ${feat(true, '<strong>Unlimited</strong>&nbsp;posts')}
              ${feat(true, 'Post scheduling')}
              ${feat(true, 'Content Vault')}
              ${feat(true, 'Multiple LinkedIn accounts')}
              ${feat(true, 'Company pages')}
              ${feat(true, 'Up to 3 workspaces')}
              ${feat(true, 'Team members')}
              ${feat(true, 'Carousel visuals')}
            </ul>
            <button class="pm-cta pm-cta-primary" id="pm-pro-btn" type="button">Upgrade now</button>
            <div class="pm-error" id="pm-pro-error"></div>
          </div>

        </div><!-- /pm-cards -->
      </div><!-- /pm-modal-body -->
    </div><!-- /pm-modal -->
  `;
  document.body.appendChild(overlay);

  // ── State ──────────────────────────────────────────────────────────────────
  let paddleConfig = null;
  let configLoaded = false;
  let currentPlan  = 'free';  // set on open() after subscription fetch

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
    if (paddleInitialized) return;
    if (paddleInitPromise) { await paddleInitPromise; return; }
    paddleInitPromise = (async () => {
      await loadPaddleScript();
      if (env !== 'production') window.Paddle.Environment.set('sandbox');
      window.Paddle.Initialize({
        token: clientToken,
        eventCallback: function (data) {
          if (data.name !== 'checkout.completed') return;
          const tid = checkoutCompletedTransactionId(data);
          try { if (tid) sessionStorage.setItem(PENDING_PADDLE_TXN_KEY, tid); } catch { /* private mode */ }
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
    })();
    await paddleInitPromise;
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
      const proPriceEl = $id('pm-pro-price');
      if (proPriceEl && d.proMonthlyPrice) proPriceEl.textContent = d.proMonthlyPrice;
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

    btn.disabled    = true;
    const origText  = btn.textContent;
    btn.textContent = 'Loading…';
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
      btn.disabled    = false;
      btn.textContent = origText;
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
      btn.disabled    = false;
      btn.textContent = origText;
    }
  }

  // ── Pro button — checkout or billing portal for Pro users ─────────────────
  $id('pm-pro-btn').addEventListener('click', async function () {
    if (this.disabled) return;

    if (currentPlan === 'pro') {
      this.disabled    = true;
      this.textContent = 'Loading…';
      try {
        const r = await fetch('/api/billing/portal');
        const d = await r.json();
        if (d.portalUrl) { window.location.href = d.portalUrl; return; }
      } catch { /* fall through */ }
      $id('pm-pro-error').textContent   = 'Unable to open billing portal.';
      $id('pm-pro-error').style.display = '';
      this.disabled    = false;
      this.textContent = 'Manage subscription';
      return;
    }

    startPlanCheckout('pro', this, $id('pm-pro-error'));
  });

  // ── open(options) ──────────────────────────────────────────────────────────
  async function open(options) {
    const opts    = (options && typeof options === 'object') ? options : {};
    const feature = opts.feature || null;

    // — Reset chips and errors
    $id('pm-pro-chip').style.display = 'none';
    $id('pm-pro-error').style.display = 'none';

    // — Reset button to default (will be updated after sub loads)
    const proBtn = $id('pm-pro-btn');
    proBtn.disabled     = false;
    proBtn.textContent  = 'Upgrade now';
    proBtn.className    = 'pm-cta pm-cta-primary';

    // — Context banner
    const bannerEl = $id('pm-context-banner');
    bannerEl.classList.remove('visible');
    if (feature && FEATURE_LABELS[feature]) {
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
    // App-level trial users have plan='pro' but no Paddle subscription yet.
    // Treat them as 'free' so the checkout button works normally.
    const isAppTrial = sub.status === 'trialing' && !sub.price_id;
    currentPlan = isAppTrial ? 'free' : (sub.plan || 'free');

    // — Apply plan state to UI
    if (currentPlan === 'pro') {
      $id('pm-pro-chip').style.display = '';
      proBtn.textContent = 'Manage subscription';
      proBtn.className   = 'pm-cta pm-cta-muted';
    }
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
  window.PricingModal = { open, close };
})();

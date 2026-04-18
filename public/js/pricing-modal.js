/* pricing-modal.js — Upgrade overlay for ScoutHook
 * Exposes window.PricingModal = { open, close }
 * Included on all protected pages via account-bar.js
 */
(function () {
  'use strict';

  /** Survives redirect when Paddle omits ?_ptxn= on successUrl (overlay checkout). */
  const PENDING_PADDLE_TXN_KEY = 'scouthook_pending_paddle_txn';

  /**
   * Paddle.js checkout.completed uses data.transaction_id (see Paddle docs).
   * Older samples used nested shapes — accept both.
   */
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

  // ── Inject styles ───────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
  #pm-overlay {
    position: fixed;
    inset: 0;
    z-index: 900;
    background: rgba(9,9,11,0.5);
    display: none;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  #pm-overlay.visible { display: flex; }

  #pm-modal {
    background: var(--bg-surface, #fff);
    border: 1px solid var(--border, #E4E4E7);
    border-radius: 16px;
    width: 100%;
    max-width: 720px;
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    box-shadow: 0 8px 40px rgba(0,0,0,0.22);
    position: relative;
    padding: 36px 36px 40px;
  }

  #pm-close {
    position: absolute;
    top: 14px; right: 14px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted, #71717A);
    padding: 4px;
    border-radius: 6px;
    line-height: 1;
    display: flex;
    align-items: center;
  }
  #pm-close:hover { background: var(--bg-pill, #F4F4F5); }

  #pm-header { text-align: center; margin-bottom: 28px; }
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

  .pm-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin-bottom: 28px;
  }
  .pm-toggle-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted, #71717A);
    cursor: pointer;
    transition: color 0.15s;
  }
  .pm-toggle-label.pm-active { color: var(--text-heading, #09090B); }

  .pm-switch {
    position: relative;
    width: 40px; height: 22px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .pm-switch input { opacity: 0; width: 0; height: 0; }
  .pm-switch-track {
    position: absolute;
    inset: 0;
    background: var(--border, #E4E4E7);
    border-radius: 22px;
    transition: background 0.2s;
  }
  .pm-switch-track::before {
    content: '';
    position: absolute;
    width: 16px; height: 16px;
    background: #fff;
    border-radius: 50%;
    top: 3px; left: 3px;
    transition: transform 0.2s;
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
  }
  .pm-switch input:checked + .pm-switch-track { background: var(--brand, #0F766E); }
  .pm-switch input:checked + .pm-switch-track::before { transform: translateX(18px); }

  .pm-save-chip {
    background: var(--accent, #10B981);
    color: #fff;
    font-size: 11px;
    font-weight: 600;
    border-radius: 20px;
    padding: 2px 7px;
  }

  .pm-cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  @media (max-width: 560px) {
    #pm-modal { padding: 24px 18px 28px; }
    .pm-cards { grid-template-columns: 1fr; }
  }

  .pm-card {
    border: 1px solid var(--border, #E4E4E7);
    border-radius: 12px;
    padding: 22px 22px 24px;
    background: var(--bg-surface, #fff);
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
  }
  .pm-plan-name.pm-pro { color: var(--brand, #0F766E); }
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
    font-size: 36px;
    font-weight: 800;
    color: var(--text-heading, #09090B);
    line-height: 1;
    margin-bottom: 4px;
  }
  .pm-price sup { font-size: 16px; font-weight: 700; vertical-align: super; }
  .pm-period {
    font-size: 12px;
    color: var(--text-muted, #71717A);
    margin-bottom: 18px;
  }
  .pm-period-sub { font-size: 11px; color: var(--text-muted, #71717A); }

  .pm-divider {
    border: none;
    border-top: 1px solid var(--border-divider, #F4F4F5);
    margin: 16px 0;
  }

  .pm-features {
    list-style: none;
    padding: 0;
    margin: 0 0 22px;
  }
  .pm-features li {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 13px;
    color: var(--text-body, #000);
    padding: 4px 0;
  }
  .pm-features li svg { flex-shrink: 0; margin-top: 1px; }
  .pm-feature-excluded { color: var(--text-muted, #A1A1AA) !important; }

  .pm-cta {
    display: block;
    width: 100%;
    padding: 11px 16px;
    border-radius: 9px;
    font-size: 13px;
    font-weight: 600;
    text-align: center;
    cursor: pointer;
    border: none;
    transition: background 0.15s, opacity 0.15s;
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
    cursor: default;
  }

  .pm-error {
    margin-top: 8px;
    font-size: 12px;
    color: var(--score-fail, #DC2626);
    text-align: center;
    display: none;
  }
  `;
  document.head.appendChild(style);

  // ── Inject HTML ─────────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'pm-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Upgrade to Pro');
  overlay.innerHTML = `
    <div id="pm-modal">
      <button id="pm-close" aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>

      <div id="pm-header">
        <h2>Simple, transparent pricing</h2>
        <p>Start free. Upgrade when you're ready to go unlimited.</p>
      </div>

      <div class="pm-toggle">
        <span class="pm-toggle-label pm-active" id="pm-monthly-lbl">Monthly</span>
        <label class="pm-switch" aria-label="Switch to annual billing">
          <input type="checkbox" id="pm-annual-toggle">
          <span class="pm-switch-track"></span>
        </label>
        <span class="pm-toggle-label" id="pm-annual-lbl">Annual &nbsp;<span class="pm-save-chip">Save 17%</span></span>
      </div>

      <div class="pm-cards">

        <!-- Free -->
        <div class="pm-card">
          <div class="pm-plan-name">
            Free
            <span class="pm-current-chip" id="pm-free-chip" style="display:none">Current plan</span>
          </div>
          <div class="pm-price"><sup>$</sup>0</div>
          <div class="pm-period">forever</div>
          <hr class="pm-divider">
          <ul class="pm-features">
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              3 post generations / month
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              3 visuals in your first month
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              1 vault document
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              LinkedIn &amp; scheduled publishing
            </li>
            <li class="pm-feature-excluded">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#A1A1AA" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Hook A/B alternatives
            </li>
            <li class="pm-feature-excluded">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#A1A1AA" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Draft hub &amp; post archive
            </li>
          </ul>
          <button class="pm-cta pm-cta-muted" disabled>Current plan</button>
        </div>

        <!-- Pro -->
        <div class="pm-card pm-featured">
          <div class="pm-plan-name pm-pro">
            Pro
            <span class="pm-current-chip" id="pm-pro-chip" style="display:none">Current plan</span>
          </div>

          <div id="pm-founding-badge" style="display:none;margin-bottom:6px;font-size:12px;font-weight:700;color:#059669;letter-spacing:0.01em;"></div>
          <div id="pm-price-monthly">
            <div class="pm-price" style="display:flex;align-items:baseline;gap:8px;">
              <span><sup>$</sup><span id="pm-monthly-amount">49</span></span>
              <span id="pm-strike-price" style="display:none;font-size:17px;font-weight:500;color:var(--text-muted,#A1A1AA);text-decoration:line-through;">$49</span>
            </div>
            <div class="pm-period">/ month</div>
          </div>
          <div id="pm-price-annual" style="display:none">
            <div class="pm-price"><sup>$</sup><span id="pm-annual-amount">490</span></div>
            <div class="pm-period">/ year &nbsp;<span class="pm-period-sub">(<span id="pm-annual-per-month">$40.83</span> / month)</span></div>
          </div>

          <hr class="pm-divider">
          <ul class="pm-features">
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <strong>40</strong>&nbsp;post generations / month
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <strong>20</strong>&nbsp;visuals / month (carousels, quotes, branded)
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <strong>10</strong>&nbsp;vault docs / month
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Unlimited scheduling (10 days ahead)
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              LinkedIn publishing
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Hook A/B alternatives
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Content funnel dashboard
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Draft hub &amp; post archive
            </li>
          </ul>
          <button class="pm-cta pm-cta-primary" id="pm-upgrade-btn" type="button">Upgrade to Pro</button>
          <div class="pm-error" id="pm-error"></div>
        </div>

      </div><!-- /pm-cards -->
    </div><!-- /pm-modal -->
  `;
  document.body.appendChild(overlay);

  // ── State ────────────────────────────────────────────────────────────────────
  let priceIdMonthly  = '';
  let priceIdYearly   = '';
  let proMonthlyPrice = 49;
  let foundingTier    = 'regular';
  let spotsRemaining  = 0;
  let configLoaded    = false;

  // ── DOM refs (resolved lazily after injection) ────────────────────────────
  function $id(id) { return document.getElementById(id); }

  // ── Paddle.js lazy loader ────────────────────────────────────────────────────
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
      if (env !== 'production') {
        window.Paddle.Environment.set('sandbox');
      }
      // Paddle docs: checkout.completed is delivered to eventCallback on Initialize(),
      // not on Checkout.open(). Without this, no keepalive sync / sessionStorage txn id runs.
      window.Paddle.Initialize({
        token: clientToken,
        eventCallback: function (data) {
          if (data.name === 'checkout.completed') {
            const tid = checkoutCompletedTransactionId(data);
            try {
              if (tid) sessionStorage.setItem(PENDING_PADDLE_TXN_KEY, tid);
            } catch { /* private mode / quota */ }
            fetch('/api/billing/sync', {
              method: 'POST',
              credentials: 'same-origin',
              keepalive: true,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ transactionId: tid }),
            }).catch(() => { /* page-load sync is the backup */ });
          }
        },
      });
      paddleInitialized = true;
    })();
    await paddleInitPromise;
  }

  // ── Config fetch ────────────────────────────────────────────────────────────
  let paddleConfig = null;

  async function loadConfig() {
    if (configLoaded) return;
    try {
      const r = await fetch('/api/billing/config');
      if (!r.ok) return;
      const d = await r.json();
      priceIdMonthly  = d.priceIdMonthly  || '';
      priceIdYearly   = d.priceIdYearly   || '';
      proMonthlyPrice = d.proMonthlyPrice  || 49;
      foundingTier    = d.foundingTier     || 'regular';
      spotsRemaining  = d.spotsRemaining   || 0;
      paddleConfig    = d;
      configLoaded    = true;
      applyConfig();
    } catch { /* no-op */ }
  }

  // ── applyConfig — update price display and founding badge after config loads ─
  function applyConfig() {
    // Update monthly price amount
    const monthlyAmountEl = $id('pm-monthly-amount');
    if (monthlyAmountEl) monthlyAmountEl.textContent = proMonthlyPrice;

    // Update annual price (17% off, rounded to nearest dollar)
    const annualTotal = Math.round(proMonthlyPrice * 12 * 0.83);
    const annualPerMonth = (proMonthlyPrice * 0.83).toFixed(2);
    const annualAmountEl = $id('pm-annual-amount');
    if (annualAmountEl) annualAmountEl.textContent = annualTotal;
    const annualPerMonthEl = $id('pm-annual-per-month');
    if (annualPerMonthEl) annualPerMonthEl.textContent = '$' + annualPerMonth;

    // Show/hide the strikethrough $49 next to the founding price
    const strikeEl = $id('pm-strike-price');
    if (strikeEl) {
      strikeEl.style.display = (foundingTier !== 'regular') ? '' : 'none';
    }

    // Show founding badge for non-regular tiers
    const badgeEl = $id('pm-founding-badge');
    if (badgeEl) {
      if (foundingTier === 'founding_1') {
        badgeEl.textContent  = 'Founding member -' + spotsRemaining + ' of 10 spots left';
        badgeEl.style.display = '';
      } else if (foundingTier === 'founding_2') {
        badgeEl.textContent  = 'Early access -' + spotsRemaining + ' of 40 spots left';
        badgeEl.style.display = '';
      } else {
        badgeEl.style.display = 'none';
      }
    }

    // Hide annual toggle for founding tiers (monthly-only offer)
    const toggleRow = document.querySelector('.pm-toggle');
    if (toggleRow) {
      toggleRow.style.display = (foundingTier === 'regular') ? '' : 'none';
    }
    // If annual toggle was on and we're now in a founding tier, reset to monthly
    if (foundingTier !== 'regular') {
      const toggle = $id('pm-annual-toggle');
      if (toggle && toggle.checked) {
        toggle.checked = false;
        setAnnual(false);
      }
    }
  }

  // ── Toggle ───────────────────────────────────────────────────────────────────
  function setAnnual(annual) {
    $id('pm-price-monthly').style.display = annual ? 'none' : '';
    $id('pm-price-annual').style.display  = annual ? '' : 'none';
    $id('pm-monthly-lbl').classList.toggle('pm-active', !annual);
    $id('pm-annual-lbl').classList.toggle('pm-active', annual);
  }

  $id('pm-annual-toggle').addEventListener('change', function () { setAnnual(this.checked); });
  $id('pm-monthly-lbl').addEventListener('click', () => { $id('pm-annual-toggle').checked = false; setAnnual(false); });
  $id('pm-annual-lbl').addEventListener('click',  () => { $id('pm-annual-toggle').checked = true;  setAnnual(true);  });

  // ── Close ────────────────────────────────────────────────────────────────────
  function close() {
    overlay.classList.remove('visible');
    document.body.style.overflow = '';
  }

  $id('pm-close').addEventListener('click', close);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay.classList.contains('visible')) close();
  });

  // ── Upgrade click ────────────────────────────────────────────────────────────
  $id('pm-upgrade-btn').addEventListener('click', async function () {
    const btn = this;
    const isAnnual = $id('pm-annual-toggle').checked;
    const priceId  = isAnnual ? priceIdYearly : priceIdMonthly;

    $id('pm-error').style.display = 'none';

    if (!priceId) {
      showError('Pricing is not configured yet. Please contact support.');
      return;
    }

    btn.disabled    = true;
    btn.textContent = 'Loading…';

    try {
      // Ensure Paddle.js is loaded and initialised with the client token
      if (!paddleConfig) await loadConfig();
      if (!paddleConfig || !paddleConfig.clientToken) {
        showError('Checkout unavailable. Please try again later.');
        btn.disabled = false; btn.textContent = 'Upgrade to Pro'; return;
      }
      await ensurePaddle(paddleConfig.clientToken, paddleConfig.env);

      // Resolve the current user for customData (userId is required by webhooks)
      let userId = null;
      try {
        const authData = await window.scouthookAuthReady;
        userId = authData?.user?.user_id ?? null;
      } catch { /* no-op */ }
      // Fallback: localStorage is set by session.js on every authenticated page load
      if (!userId) {
        try { userId = localStorage.getItem('scouthook_uid'); } catch { /* no-op */ }
      }

      // Open Paddle overlay checkout
      window.Paddle.Checkout.open({
        items: [{ priceId, quantity: 1 }],
        customData: userId ? { userId } : undefined,
        settings: {
          displayMode: 'overlay',
          successUrl: window.location.origin + '/billing.html?checkout=success',
        },
      });

      // Reset button — user may close the overlay without completing
      btn.disabled    = false;
      btn.textContent = 'Upgrade to Pro';
    } catch (err) {
      console.error('[pricing-modal] checkout error:', err);
      showError('Unable to start checkout. Please try again.');
      btn.disabled    = false;
      btn.textContent = 'Upgrade to Pro';
    }
  });

  function showError(msg) {
    const el = $id('pm-error');
    el.textContent    = msg;
    el.style.display  = '';
  }

  // ── open() ───────────────────────────────────────────────────────────────────
  async function open() {
    // Reset state
    $id('pm-error').style.display  = 'none';
    $id('pm-annual-toggle').checked = false;
    setAnnual(false);
    $id('pm-free-chip').style.display = 'none';
    $id('pm-pro-chip').style.display  = 'none';

    const upgradeBtn = $id('pm-upgrade-btn');
    upgradeBtn.disabled    = false;
    upgradeBtn.textContent = 'Upgrade to Pro';
    upgradeBtn.className   = 'pm-cta pm-cta-primary';
    upgradeBtn.style.display = '';

    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';

    // Load config + subscription concurrently
    const [, subRes] = await Promise.allSettled([
      loadConfig(),
      fetch('/api/billing/subscription').then(r => r.json()).catch(() => null),
    ]);
    // If config was already cached, applyConfig() wasn't called inside loadConfig() — apply now
    if (configLoaded) applyConfig();

    const sub = subRes.status === 'fulfilled' ? subRes.value : null;
    const plan = sub?.plan || 'free';

    if (plan === 'pro') {
      $id('pm-pro-chip').style.display   = '';
      upgradeBtn.textContent = 'Manage subscription';
      upgradeBtn.className   = 'pm-cta pm-cta-muted';
      upgradeBtn.disabled    = true;
      // Replace upgrade handler with portal redirect for Pro users
      upgradeBtn.onclick = async function () {
        upgradeBtn.disabled    = true;
        upgradeBtn.textContent = 'Loading…';
        try {
          const r = await fetch('/api/billing/portal');
          const d = await r.json();
          if (d.portalUrl) { window.location.href = d.portalUrl; return; }
        } catch { /* fall through */ }
        showError('Unable to open billing portal.');
        upgradeBtn.disabled    = false;
        upgradeBtn.textContent = 'Manage subscription';
      };
      upgradeBtn.disabled = false;
    } else {
      $id('pm-free-chip').style.display  = '';
      upgradeBtn.onclick = null; // use the default addEventListener handler above
    }
  }

  // ── Post-checkout sync on success redirect ───────────────────────────────────
  // Paddle may append ?_ptxn=txn_xxx; overlay often omits it — use sessionStorage
  // filled in checkout.completed as a backup.
  if (window.location.search.includes('checkout=success')) {
    const _params = new URLSearchParams(window.location.search);
    let _txnId = _params.get('_ptxn') || null;
    if (!_txnId) {
      try {
        _txnId = sessionStorage.getItem(PENDING_PADDLE_TXN_KEY);
      } catch { /* no-op */ }
    }
    fetch('/api/billing/sync', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId: _txnId }),
    })
      .then(function (r) {
        if (r.ok) {
          try {
            sessionStorage.removeItem(PENDING_PADDLE_TXN_KEY);
          } catch { /* no-op */ }
        }
      })
      .catch(() => { /* no-op */ });
  }

  // ── Expose globally ──────────────────────────────────────────────────────────
  window.PricingModal = { open, close };
})();

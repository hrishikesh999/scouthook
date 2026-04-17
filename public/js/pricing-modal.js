/* pricing-modal.js — Upgrade overlay for ScoutHook
 * Exposes window.PricingModal = { open, close }
 * Included on all protected pages via account-bar.js
 */
(function () {
  'use strict';

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
              5 post generations / month
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              1 vault document
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              LinkedIn publishing
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Scheduled publishing
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

          <div id="pm-price-monthly">
            <div class="pm-price"><sup>$</sup>49</div>
            <div class="pm-period">/ month</div>
          </div>
          <div id="pm-price-annual" style="display:none">
            <div class="pm-price"><sup>$</sup>490</div>
            <div class="pm-period">/ year &nbsp;<span class="pm-period-sub">($40.83 / month)</span></div>
          </div>

          <hr class="pm-divider">
          <ul class="pm-features">
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <strong>Unlimited</strong>&nbsp;post generations
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <strong>Unlimited</strong>&nbsp;vault documents
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              LinkedIn publishing
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Scheduled publishing
            </li>
            <li>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#10B981)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Visual generation (carousels &amp; quote cards)
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
  let priceIdMonthly = '';
  let priceIdYearly  = '';
  let configLoaded   = false;

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
      window.Paddle.Initialize({ token: clientToken });
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
      priceIdMonthly = d.priceIdMonthly || '';
      priceIdYearly  = d.priceIdYearly  || '';
      paddleConfig   = d;
      configLoaded   = true;
    } catch { /* no-op */ }
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
      } catch { /* proceed without userId — webhook will try fallback */ }

      // Open Paddle overlay checkout
      window.Paddle.Checkout.open({
        items: [{ priceId, quantity: 1 }],
        customData: userId ? { userId } : undefined,
        settings: {
          successUrl: window.location.origin + window.location.pathname + '?checkout=success',
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

  // ── Expose globally ──────────────────────────────────────────────────────────
  window.PricingModal = { open, close };
})();

/* workspace-modal.js — Premium "New workspace" flow for ScoutHook
 * Exposes window.WorkspaceModal = { open, close }
 * Loaded dynamically by account-bar.js on all sidebar pages.
 *
 * Three states:
 *   create  — name input, immediate creation
 *   upgrade — Free/Solo user hit limit → prompt to upgrade to Pro
 *   addon   — Pro user hit limit → Paddle checkout for $29/mo extra slot
 */
(function () {
  'use strict';

  if (window.WorkspaceModal) return;

  const PENDING_NAME_KEY = 'wm_pending_name';
  const PENDING_TID_KEY  = 'wm_pending_tid';

  // Module-level guard — prevents registering duplicate bus handlers if
  // startAddonCheckout() is called more than once (double-click, retry, etc.)
  let busHandlerRegistered = false;

  // ── Inject styles ──────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
  #wm-overlay {
    position: fixed;
    inset: 0;
    z-index: 950;
    background: rgba(9,9,11,0.55);
    backdrop-filter: blur(4px);
    display: none;
    align-items: center;
    justify-content: center;
    padding: 24px 16px;
  }
  #wm-overlay.visible { display: flex; }

  #wm-modal {
    background: var(--bg-surface, #fff);
    border: 1px solid var(--border, #E4E4E7);
    border-radius: 20px;
    width: 100%;
    max-width: 420px;
    position: relative;
    box-shadow: 0 20px 60px rgba(0,0,0,0.22), 0 0 0 1px rgba(0,0,0,0.04);
    overflow: hidden;
    animation: wm-in 0.18s ease;
  }
  @keyframes wm-in {
    from { opacity: 0; transform: scale(0.96) translateY(6px); }
    to   { opacity: 1; transform: scale(1)    translateY(0);   }
  }
  #wm-modal::before {
    content: '';
    display: block;
    height: 4px;
    background: linear-gradient(90deg, #0D9488 0%, #0F766E 100%);
  }

  #wm-body { padding: 32px 32px 28px; }

  #wm-close {
    position: absolute;
    top: 14px; right: 14px;
    z-index: 2;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted, #71717A);
    padding: 6px;
    border-radius: 8px;
    line-height: 1;
    display: flex;
    align-items: center;
    transition: background 0.15s, color 0.15s;
  }
  #wm-close:hover { background: var(--bg-pill, #F4F4F5); color: var(--text-heading, #09090B); }

  .wm-title {
    font-size: 20px;
    font-weight: 800;
    color: var(--text-heading, #09090B);
    letter-spacing: -0.3px;
    margin: 0 0 4px;
    line-height: 1.25;
  }
  .wm-sub {
    font-size: 14px;
    color: var(--text-muted, #71717A);
    margin: 0 0 24px;
    line-height: 1.5;
  }

  .wm-label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-heading, #09090B);
    margin-bottom: 6px;
  }
  #wm-name {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 13px;
    font-size: 15px;
    border: 1.5px solid var(--border, #E4E4E7);
    border-radius: 10px;
    background: var(--bg-surface, #fff);
    color: var(--text-heading, #09090B);
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
    font-family: inherit;
  }
  #wm-name:focus {
    border-color: #0D9488;
    box-shadow: 0 0 0 3px rgba(13,148,136,0.12);
  }
  #wm-name::placeholder { color: var(--text-muted, #71717A); }

  #wm-error {
    font-size: 13px;
    color: #DC2626;
    margin: 8px 0 0;
    display: none;
  }

  .wm-btn {
    display: block;
    width: 100%;
    padding: 12px 18px;
    border-radius: 11px;
    font-size: 15px;
    font-weight: 700;
    text-align: center;
    cursor: pointer;
    border: none;
    transition: opacity 0.15s, transform 0.1s;
    font-family: inherit;
    letter-spacing: -0.1px;
  }
  .wm-btn:active:not(:disabled) { transform: scale(0.98); }
  .wm-btn:disabled { opacity: 0.55; cursor: not-allowed; }

  .wm-btn-primary {
    background: linear-gradient(135deg, #0D9488 0%, #0F766E 100%);
    color: #fff;
    box-shadow: 0 4px 14px rgba(13,148,136,0.3);
    margin-top: 20px;
  }
  .wm-btn-primary:hover:not(:disabled) { opacity: 0.92; }

  .wm-btn-ghost {
    background: none;
    color: var(--text-muted, #71717A);
    border: 1.5px solid var(--border, #E4E4E7);
    margin-top: 10px;
  }
  .wm-btn-ghost:hover:not(:disabled) { background: var(--bg-pill, #F4F4F5); color: var(--text-heading, #09090B); }

  .wm-badge {
    display: inline-block;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #0F766E;
    background: rgba(13,148,136,0.08);
    border: 1px solid rgba(13,148,136,0.2);
    border-radius: 20px;
    padding: 3px 10px;
    margin-bottom: 12px;
  }

  #wm-addon-error {
    font-size: 13px;
    color: #DC2626;
    margin: 8px 0 0;
    display: none;
  }

  @media (max-width: 480px) {
    #wm-body { padding: 24px 20px 20px; }
    .wm-title { font-size: 18px; }
  }
  `;
  document.head.appendChild(style);

  // ── Inject HTML ────────────────────────────────────────────────────────────
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
  <div id="wm-overlay" role="dialog" aria-modal="true" aria-labelledby="wm-title-create">
    <div id="wm-modal">
      <button id="wm-close" aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div id="wm-body">

        <!-- State A: create workspace -->
        <div id="wm-state-create">
          <h2 class="wm-title" id="wm-title-create">New workspace</h2>
          <p class="wm-sub">Give your workspace a name to get started.</p>
          <label class="wm-label" for="wm-name">Workspace name</label>
          <input id="wm-name" type="text" placeholder="e.g. Client work, Personal brand" maxlength="80" autocomplete="off" spellcheck="false">
          <p id="wm-error"></p>
          <button class="wm-btn wm-btn-primary" id="wm-create-btn">Create workspace</button>
        </div>

        <!-- State B: upgrade required (Free / Solo) -->
        <div id="wm-state-upgrade" style="display:none">
          <h2 class="wm-title">Upgrade to create more</h2>
          <p class="wm-sub">Your current plan includes 1 workspace. Upgrade to Pro to unlock 2 workspaces plus unlimited content generation, scheduling, and more.</p>
          <button class="wm-btn wm-btn-primary" id="wm-upgrade-btn">Upgrade to Pro →</button>
          <button class="wm-btn wm-btn-ghost" id="wm-upgrade-cancel">Cancel</button>
        </div>

        <!-- State C: addon purchase (Pro at limit) -->
        <div id="wm-state-addon" style="display:none">
          <span class="wm-badge">Pro add-on · $29/mo</span>
          <h2 class="wm-title">Add another workspace</h2>
          <p class="wm-sub">You're using all workspaces included in your Pro plan. Add more at $29/month each — cancel any time.</p>
          <p id="wm-addon-error"></p>
          <button class="wm-btn wm-btn-primary" id="wm-addon-btn">Add workspace · $29/mo →</button>
          <button class="wm-btn wm-btn-ghost" id="wm-addon-cancel">Cancel</button>
        </div>

      </div>
    </div>
  </div>`;
  document.body.appendChild(wrapper.firstElementChild);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const $  = id => document.getElementById(id);
  const overlay    = $('wm-overlay');
  const nameInput  = $('wm-name');
  const errorEl    = $('wm-error');
  const addonError = $('wm-addon-error');

  function showState(name) {
    $('wm-state-create').style.display  = name === 'create'  ? '' : 'none';
    $('wm-state-upgrade').style.display = name === 'upgrade' ? '' : 'none';
    $('wm-state-addon').style.display   = name === 'addon'   ? '' : 'none';
  }

  function setError(el, msg) {
    el.textContent    = msg || '';
    el.style.display  = msg ? '' : 'none';
  }

  function setBtn(btn, busy, busyLabel) {
    btn.disabled    = busy;
    if (busyLabel) btn.dataset.origText = btn.dataset.origText || btn.textContent;
    btn.textContent = busy ? (busyLabel || btn.dataset.origText) : (btn.dataset.origText || btn.textContent);
  }

  // ── Open / close ───────────────────────────────────────────────────────────
  function open() {
    showState('create');
    nameInput.value = '';
    setError(errorEl, '');
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => nameInput.focus());
  }

  function close() {
    overlay.classList.remove('visible');
    document.body.style.overflow = '';
  }

  // ── Workspace creation ─────────────────────────────────────────────────────
  async function attemptCreate(name) {
    const btn = $('wm-create-btn');
    setBtn(btn, true, 'Creating…');
    setError(errorEl, '');

    try {
      const resp = await fetch('/api/workspaces', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await resp.json();

      if (data.ok && data.redirect) {
        window.location.href = data.redirect;
        return;
      }

      if (data.error === 'workspace_limit_reached') {
        try { sessionStorage.setItem(PENDING_NAME_KEY, name); } catch { /* private mode */ }
        showState(data.canAddOn ? 'addon' : 'upgrade');
        return;
      }

      setError(errorEl,
        data.error === 'name_required'
          ? 'Please enter a workspace name.'
          : (data.error || 'Something went wrong. Please try again.')
      );
    } catch {
      setError(errorEl, 'Network error. Please check your connection and try again.');
    } finally {
      setBtn(btn, false);
    }
  }

  // ── Paddle add-on checkout ─────────────────────────────────────────────────
  async function loadPaddle() {
    if (window.Paddle) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
      s.onload  = resolve;
      s.onerror = () => reject(new Error('Failed to load Paddle.js'));
      document.head.appendChild(s);
    });
  }

  async function startAddonCheckout() {
    const btn = $('wm-addon-btn');
    setBtn(btn, true, 'Loading…');
    setError(addonError, '');

    try {
      const [configRes, addonRes] = await Promise.all([
        fetch('/api/billing/config').then(r => r.json()),
        fetch('/api/billing/add-workspace', { method: 'POST', credentials: 'same-origin' }).then(r => r.json()),
      ]);

      if (!addonRes.ok || !addonRes.priceId) {
        throw new Error(addonRes.error === 'pro_required'
          ? 'This add-on requires an active Pro subscription.'
          : (addonRes.error || 'price_not_configured'));
      }

      await loadPaddle();

      // Register our event handler on the shared bus BEFORE initialising Paddle,
      // so we claim checkout.completed events that belong to this flow.
      // The handler ONLY stores the transactionId and returns true (claims the event).
      // Actual workspace creation happens in handlePageLoadReturn() via the successUrl
      // redirect — keeping the async work in one place and eliminating the race where
      // both the eventCallback navigation and the successUrl redirect fire simultaneously.
      window._paddleEventBus = window._paddleEventBus || [];
      if (!busHandlerRegistered) {
        window._paddleEventBus.unshift(function claimAddonCheckout(data) {
          if (data.name !== 'checkout.completed') return false;
          let pendingName;
          try { pendingName = sessionStorage.getItem(PENDING_NAME_KEY); } catch { return false; }
          if (!pendingName) return false;
          // Persist the transaction ID so handlePageLoadReturn can send it to /api/billing/sync
          const tid = (data.data && (data.data.transaction_id || data.data.transactionId)) || null;
          try { if (tid) sessionStorage.setItem(PENDING_TID_KEY, tid); } catch {}
          return true; // claimed — prevents pricing-modal from redirecting to /billing.html
        });
        busHandlerRegistered = true;
      }

      // Initialise Paddle only if no other module has done so yet.
      // window._paddleInitialized is a shared flag set by whichever module (pricing-modal
      // or this one) calls Paddle.Initialize() first. Calling Initialize() twice throws,
      // and the second eventCallback would silently overwrite the first.
      if (!window._paddleInitialized) {
        if (!configRes.clientToken) {
          throw new Error('checkout_not_configured');
        }
        try {
          if (configRes.env !== 'production') window.Paddle.Environment.set('sandbox');
          window.Paddle.Initialize({
            token: configRes.clientToken,
            eventCallback: function (data) {
              const claimed = (window._paddleEventBus || []).some(function (h) {
                try { return h(data) === true; } catch { return false; }
              });
              if (claimed) return;
              // Fallback: standard sync (pricing-modal not loaded on this page)
              if (data.name !== 'checkout.completed') return;
              const tid = (data.data && (data.data.transaction_id || data.data.transactionId)) || null;
              if (tid) {
                fetch('/api/billing/sync', {
                  method: 'POST', credentials: 'same-origin', keepalive: true,
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ transactionId: tid }),
                }).catch(() => {});
              }
            },
          });
          window._paddleInitialized = true;
        } catch {
          // Paddle was already initialized by pricing-modal — their eventCallback
          // dispatches to _paddleEventBus, so our bus handler is still active.
          window._paddleInitialized = true;
        }
      }

      close(); // close modal before Paddle overlay appears

      window.Paddle.Checkout.open({
        items: [{ priceId: addonRes.priceId, quantity: 1 }],
        // customData is returned by /api/billing/add-workspace and contains userId +
        // type + quantity for webhook attribution and fraud detection.
        customData: addonRes.customData || undefined,
        settings: {
          displayMode: 'overlay',
          // successUrl is a fallback if eventCallback redirect doesn't fire
          successUrl: window.location.origin + window.location.pathname + '?wm_checkout=1',
        },
      });

    } catch (err) {
      const msg = err.message === 'checkout_not_configured'
        ? 'Checkout not yet configured. Please contact support.'
        : err.message === 'pro_required'
          ? 'This add-on requires an active Pro plan.'
          : (err.message || 'Unable to start checkout. Please try again.');
      setError(addonError, msg);
      setBtn(btn, false);
    }
  }

  // ── Post-checkout: sync billing then create workspace ──────────────────────
  async function handlePostCheckout(transactionId, pendingName) {
    try {
      sessionStorage.removeItem(PENDING_NAME_KEY);
      sessionStorage.removeItem(PENDING_TID_KEY);
    } catch { /* no-op */ }

    // Sync subscription (increments extra_workspaces)
    await fetch('/api/billing/sync', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId: transactionId || '' }),
    }).catch(e => console.warn('[workspace-modal] billing sync failed:', e?.message));

    // Retry workspace creation up to 3 times with increasing delays.
    // The billing sync may need a moment to propagate extra_workspaces to the DB.
    // Only retry on workspace_limit_reached; any other error is a genuine failure.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1000)); // 1s, 2s
      try {
        const resp = await fetch('/api/workspaces', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: pendingName }),
        });
        const data = await resp.json();
        if (data.ok && data.redirect) {
          window.location.href = data.redirect;
          return;
        }
        if (data.error !== 'workspace_limit_reached') break; // real error — stop retrying
      } catch { break; }
    }

    // All attempts failed — open modal with name pre-filled so user can retry manually
    nameInput.value = pendingName;
    setError(errorEl, 'Purchase succeeded but workspace creation failed — your slot is ready. Try again.');
    showState('create');
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  // ── successUrl fallback: handle ?wm_checkout=1 on page load ───────────────
  async function handlePageLoadReturn() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('wm_checkout')) return;
    history.replaceState({}, '', window.location.pathname);

    let pendingName, transactionId;
    try {
      pendingName    = sessionStorage.getItem(PENDING_NAME_KEY);
      transactionId  = sessionStorage.getItem(PENDING_TID_KEY);
    } catch { return; }
    if (!pendingName) return;

    // transactionId was stored by the bus handler in the eventCallback; may be null
    // if the event didn't fire (e.g. page refreshed mid-checkout) — sync will fall
    // back to customer ID lookup in that case.
    await handlePostCheckout(transactionId, pendingName);
  }

  // ── Event listeners ────────────────────────────────────────────────────────
  $('wm-close').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('visible')) close();
  });

  // State A
  $('wm-create-btn').addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) {
      setError(errorEl, 'Please enter a workspace name.');
      nameInput.focus();
      return;
    }
    attemptCreate(name);
  });
  nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') $('wm-create-btn').click();
  });

  // State B
  $('wm-upgrade-btn').addEventListener('click', () => {
    close();
    if (window.PricingModal) { window.PricingModal.open(); }
    else { window.location.href = '/billing.html'; }
  });
  $('wm-upgrade-cancel').addEventListener('click', close);

  // State C
  $('wm-addon-btn').addEventListener('click', startAddonCheckout);
  $('wm-addon-cancel').addEventListener('click', close);

  // Run successUrl fallback on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', handlePageLoadReturn);
  } else {
    handlePageLoadReturn();
  }

  window.WorkspaceModal = { open, close };
})();

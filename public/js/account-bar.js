/* account-bar.js — sidebar signed-in user + logout + global topbar */

(function () {
  function initials(name, email) {
    const s = (name || email || '?').trim();
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return s.slice(0, 2).toUpperCase();
  }

  async function logOut() {
    try {
      await fetch('/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch { /* still redirect */ }
    try {
      localStorage.removeItem('scouthook_uid');
    } catch { /* ignore */ }
    window.location.href = '/login.html';
  }

  function safeImageUrl(u) {
    if (!u || typeof u !== 'string') return null;
    try {
      const parsed = new URL(u, window.location.origin);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
      return parsed.href;
    } catch {
      return null;
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, '&#39;');
  }

  // ── Workspace switcher ───────────────────────────────────────
  async function renderWorkspaceSwitcher(activeWorkspaceId) {
    const slot = document.getElementById('workspace-switcher-slot');
    if (!slot) return;

    let workspaces;
    try {
      const r = await fetch('/api/workspaces', { credentials: 'same-origin' });
      if (!r.ok) return;
      const d = await r.json();
      if (!d.ok || !Array.isArray(d.workspaces) || d.workspaces.length === 0) return;
      workspaces = d.workspaces;
    } catch { return; }

    const active = workspaces.find(w => w.id === activeWorkspaceId) || workspaces[0];

    const svgBuilding = '<svg class="ws-sw-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>';
    const svgChevron = '<svg class="ws-sw-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
    const svgPlus    = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

    const itemsHtml = workspaces.map(w => {
      const isActive = w.id === active.id;
      return `<button type="button" class="ws-sw-item${isActive ? ' ws-sw-active' : ''}" data-ws-id="${escapeAttr(w.id)}" role="menuitem">
        <span class="ws-sw-check">${isActive ? '&#10003;' : ''}</span>${escapeHtml(w.name)}
      </button>`;
    }).join('');

    slot.innerHTML = `
      <div class="ws-sw" id="ws-sw">
        <button type="button" class="ws-sw-btn" id="ws-sw-btn" aria-label="Switch workspace" aria-expanded="false" aria-haspopup="true">
          ${svgBuilding}<span class="ws-sw-name">${escapeHtml(active.name)}</span>${svgChevron}
        </button>
        <div class="ws-sw-menu" id="ws-sw-menu" hidden role="menu">
          ${itemsHtml}
          <hr class="ws-sw-divider">
          <button type="button" class="ws-sw-new" id="ws-sw-new" role="menuitem">
            ${svgPlus} New workspace
          </button>
        </div>
      </div>
    `;

    const sw      = slot.querySelector('#ws-sw');
    const swBtn   = slot.querySelector('#ws-sw-btn');
    const swMenu  = slot.querySelector('#ws-sw-menu');

    function closeMenu() {
      swMenu.hidden = true;
      sw.classList.remove('ws-sw-open');
      swBtn.setAttribute('aria-expanded', 'false');
    }

    swBtn.addEventListener('click', e => {
      e.stopPropagation();
      const opening = swMenu.hidden;
      swMenu.hidden = !opening;
      sw.classList.toggle('ws-sw-open', opening);
      swBtn.setAttribute('aria-expanded', String(opening));
    });

    document.addEventListener('click', closeMenu);

    slot.querySelectorAll('.ws-sw-item').forEach(item => {
      item.addEventListener('click', async e => {
        e.stopPropagation();
        const wsId = item.dataset.wsId;
        if (wsId === active.id) { closeMenu(); return; }
        try {
          const resp = await fetch(`/api/workspaces/${wsId}/switch`, { method: 'POST', credentials: 'same-origin' });
          const data = await resp.json();
          if (data.ok) window.location.href = data.redirect || '/dashboard.html';
        } catch { /* page reload on next interaction will correct state */ }
      });
    });

    slot.querySelector('#ws-sw-new').addEventListener('click', async e => {
      e.stopPropagation();
      closeMenu();
      const name = window.prompt('New workspace name:');
      if (!name || !name.trim()) return;
      try {
        const resp = await fetch('/api/workspaces', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim() }),
        });
        const data = await resp.json();
        if (data.ok && data.workspaceId) {
          await fetch(`/api/workspaces/${data.workspaceId}/switch`, { method: 'POST', credentials: 'same-origin' });
          window.location.href = '/dashboard.html';
        } else {
          window.alert(data.error || 'Failed to create workspace');
        }
      } catch { /* ignore */ }
    });
  }

  // ── Sidebar account foot ─────────────────────────────────────
  function renderSidebarAccount(user) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    const slot = sidebar.querySelector('#sidebar-account-slot');
    if (!slot) return;

    const label = user.displayName || user.email || 'Google user';
    const email = user.email && user.email !== label ? user.email : '';
    const photoUrl = safeImageUrl(user.photo);

    slot.innerHTML = `
      <div class="sidebar-account-foot-inner">
        <span class="sidebar-account-foot-label">Account</span>
        <div class="sidebar-account-foot-row">
          <span class="sidebar-account-foot-avatar" aria-hidden="true"></span>
          <span class="sidebar-account-foot-name" title="${escapeAttr(user.email || '')}">${escapeHtml(label)}</span>
        </div>
        ${email ? `<span class="sidebar-account-foot-email" title="${escapeAttr(email)}">${escapeHtml(email)}</span>` : ''}
        <button type="button" class="sidebar-account-foot-logout">Log out</button>
      </div>
    `;

    const av = slot.querySelector('.sidebar-account-foot-avatar');
    if (av) {
      if (photoUrl) {
        av.innerHTML = `<img class="sidebar-account-foot-avatar-img" src="${escapeAttr(photoUrl)}" alt="" />`;
      } else {
        av.textContent = initials(label, user.email);
      }
    }

    slot.querySelector('.sidebar-account-foot-logout').addEventListener('click', logOut);
  }

  // ── Page header actions (help + upgrade) ────────────────────
  function renderPageHeaderActions() {
    const header = document.querySelector('#main-content .page-header');
    if (!header || header.querySelector('.page-header-actions')) return;

    const actions = document.createElement('div');
    actions.className = 'page-header-actions';
    actions.innerHTML = `
      <a href="/help.html" class="page-header-help">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        Help
      </a>
    `;
    header.appendChild(actions);
  }

  // ── Trial banner (site-wide, dismissible) ────────────────────
  async function initTrialBanner() {
    if (localStorage.getItem('trial_banner_dismissed')) return;
    try {
      const r = await fetch('/api/billing/subscription', { credentials: 'same-origin' });
      const sub = await r.json();
      if (!sub.ok || sub.status !== 'trialing' || !sub.trial_ends_at) return;
      const daysLeft = Math.max(0, Math.ceil((new Date(sub.trial_ends_at) - Date.now()) / 86400000));
      if (daysLeft <= 0) return;

      const banner = document.createElement('div');
      banner.id = 'trial-banner';
      banner.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:8000',
        'background:#4f46e5', 'color:#fff',
        'display:flex', 'align-items:center', 'justify-content:center',
        'gap:16px', 'padding:10px 16px',
        'font-size:14px', 'font-weight:500',
      ].join(';');
      banner.innerHTML = `
        <span>${daysLeft} day${daysLeft !== 1 ? 's' : ''} left in your free trial.</span>
        <a href="/billing.html" style="color:#fff;font-weight:700;text-decoration:underline">Upgrade now →</a>
        <button type="button"
          style="background:none;border:none;color:rgba(255,255,255,0.7);cursor:pointer;font-size:18px;line-height:1;padding:0 4px"
          aria-label="Dismiss trial banner">✕</button>
      `;
      document.body.prepend(banner);
      banner.querySelector('button').addEventListener('click', () => {
        localStorage.setItem('trial_banner_dismissed', '1');
        banner.remove();
      });
    } catch { /* non-fatal */ }
  }

  async function renderSidebarUpgrade() {
    const sidebarBottom = document.querySelector('#sidebar .sidebar-bottom');
    if (!sidebarBottom) return;
    try {
      const r = await fetch('/api/billing/subscription');
      if (!r.ok) return;
      const d = await r.json();
      if (d.plan !== 'free') return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sidebar-upgrade-btn';
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
        Upgrade to Pro
      `;
      btn.addEventListener('click', () => window.PricingModal?.open());
      sidebarBottom.insertBefore(btn, sidebarBottom.firstChild);
    } catch { /* ignore */ }
  }

  // ── Load shared scripts ──────────────────────────────────────
  if (!document.getElementById('pricing-modal-script')) {
    const s = document.createElement('script');
    s.id  = 'pricing-modal-script';
    s.src = '/js/pricing-modal.js';
    document.head.appendChild(s);
  }

  if (!document.getElementById('feedback-widget-script')) {
    const s = document.createElement('script');
    s.id  = 'feedback-widget-script';
    s.src = '/js/feedback-widget.js';
    document.head.appendChild(s);
  }

  // ── Mini-onboarding modal (fires when ?new_profile_id=N is in URL) ──────────
  // Triggered after connecting a personal LinkedIn account. Lets the user set up
  // the new profile's voice DNA immediately (or skip to do it later in Settings).
  function initMiniOnboarding() {
    const params        = new URLSearchParams(window.location.search);
    const newProfileId  = params.get('new_profile_id');
    if (!newProfileId || isNaN(Number(newProfileId))) return;

    // Remove param from URL without a reload so back/forward stays clean
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('new_profile_id');
    window.history.replaceState({}, '', cleanUrl.toString());

    // Fetch profile name from connections list (cheapest source of profile metadata)
    fetch('/api/linkedin/connections', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => {
        let profileName = 'this profile';
        if (d.ok && Array.isArray(d.profiles)) {
          const match = d.profiles.find(p => String(p.id) === String(newProfileId));
          if (match && match.display_name) profileName = match.display_name;
        }
        showMiniOnboardingModal(Number(newProfileId), profileName);
      })
      .catch(() => showMiniOnboardingModal(Number(newProfileId), 'this profile'));
  }

  function showMiniOnboardingModal(profileId, profileName) {
    // Prevent duplicate modals
    if (document.getElementById('mini-ob-overlay')) return;

    const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    const overlay = document.createElement('div');
    overlay.id = 'mini-ob-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9000',
      'background:rgba(0,0,0,0.45)', 'display:flex',
      'align-items:center', 'justify-content:center', 'padding:16px',
    ].join(';');

    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="mini-ob-title"
           style="background:#fff;border-radius:12px;padding:32px;max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.2);position:relative;">
        <h2 id="mini-ob-title" style="font-size:18px;font-weight:700;color:#111827;margin:0 0 6px">
          Set up ${esc(profileName)}'s voice
        </h2>
        <p style="font-size:14px;color:#6b7280;margin:0 0 20px;line-height:1.5">
          A few quick inputs let Scouthook write posts that sound like ${esc(profileName)}.
          Skip for now — you can always set this up in Settings → LinkedIn.
        </p>

        <label style="display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px" for="mini-ob-samples">
          Paste 2–3 of their best LinkedIn posts (optional)
        </label>
        <textarea id="mini-ob-samples" rows="5" placeholder="Paste post text here…"
          style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:10px 12px;font-size:14px;resize:vertical;font-family:inherit;line-height:1.5;color:#111827;outline:none;margin-bottom:16px"></textarea>

        <label style="display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px" for="mini-ob-q1">
          What do most people in their field get wrong?
        </label>
        <textarea id="mini-ob-q1" rows="2" placeholder="Their contrarian view or hot take…"
          style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:10px 12px;font-size:14px;resize:vertical;font-family:inherit;line-height:1.5;color:#111827;outline:none;margin-bottom:16px"></textarea>

        <label style="display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px" for="mini-ob-q2">
          What do they actually do all day?
        </label>
        <textarea id="mini-ob-q2" rows="2" placeholder="Day-to-day work, clients, problems they solve…"
          style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:10px 12px;font-size:14px;resize:vertical;font-family:inherit;line-height:1.5;color:#111827;outline:none;margin-bottom:20px"></textarea>

        <div id="mini-ob-error" style="display:none;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 12px;font-size:13px;color:#b91c1c;margin-bottom:12px"></div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <button id="mini-ob-skip" type="button"
            style="background:none;border:none;font-size:14px;color:#6b7280;cursor:pointer;padding:0;text-decoration:underline">
            Set up later
          </button>
          <button id="mini-ob-submit" type="button"
            style="background:#6366f1;color:#fff;border:none;border-radius:8px;padding:11px 20px;font-size:14px;font-weight:600;cursor:pointer;transition:background 0.15s">
            Save voice setup →
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    function closeModal() {
      overlay.remove();
    }

    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal();
    });

    document.getElementById('mini-ob-skip').addEventListener('click', closeModal);

    document.getElementById('mini-ob-submit').addEventListener('click', async () => {
      const btn     = document.getElementById('mini-ob-submit');
      const errBox  = document.getElementById('mini-ob-error');
      const samples = (document.getElementById('mini-ob-samples').value || '').trim();
      const q1      = (document.getElementById('mini-ob-q1').value || '').trim();
      const q2      = (document.getElementById('mini-ob-q2').value || '').trim();

      errBox.style.display = 'none';

      if (!samples && !q1 && !q2) {
        errBox.textContent = 'Please fill in at least one field, or click "Set up later" to skip.';
        errBox.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Saving…';

      try {
        const resp = await fetch(`/api/profile/${profileId}/voice-setup`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ writingSamples: samples || null, q1: q1 || null, q2: q2 || null }),
        });
        const data = await resp.json();

        if (data.ok) {
          closeModal();
        } else {
          errBox.textContent = 'Save failed. Please try again.';
          errBox.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Save voice setup →';
        }
      } catch {
        errBox.textContent = 'Network error. Please try again.';
        errBox.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Save voice setup →';
      }
    });
  }

  // ── Boot ─────────────────────────────────────────────────────
  // Render page header actions immediately (help link doesn't need auth)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderPageHeaderActions);
  } else {
    renderPageHeaderActions();
  }

  const auth = window.scouthookAuthReady;
  if (auth && typeof auth.then === 'function') {
    auth
      .then((data) => {
        const user = data && data.user;
        if (!user || !user.user_id) return;
        renderWorkspaceSwitcher(user.tenant_id);
        renderSidebarAccount(user);
        renderSidebarUpgrade();
        initTrialBanner();
        initMiniOnboarding();
      })
      .catch(() => { /* offline */ });
  }
})();

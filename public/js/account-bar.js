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
        renderSidebarAccount(user);
        renderSidebarUpgrade();
      })
      .catch(() => { /* offline */ });
  }
})();

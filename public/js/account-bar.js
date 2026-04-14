/* account-bar.js — sidebar signed-in user + logout (no floating widget) */

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

  const auth = window.scouthookAuthReady;
  if (auth && typeof auth.then === 'function') {
    auth
      .then((data) => {
        const user = data && data.user;
        if (!user || !user.user_id) return;
        renderSidebarAccount(user);
      })
      .catch(() => { /* offline */ });
  }
})();

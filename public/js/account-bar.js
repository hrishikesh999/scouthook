/* account-bar.js — signed-in user strip (bottom-right) + sidebar account footer */

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

  function renderFloatingBar(user) {
    const label = user.displayName || user.email || 'Google user';
    const email = user.email && user.email !== label ? user.email : '';
    const photoUrl = safeImageUrl(user.photo);

    const bar = document.createElement('div');
    bar.id = 'app-user-bar';
    bar.className = 'app-user-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Your account');

    bar.innerHTML = `
      <div class="app-user-bar-main">
        <div class="app-user-bar-avatar"></div>
        <div class="app-user-bar-text">
          <div class="app-user-bar-kicker">Signed in as</div>
          <div class="app-user-bar-name">${escapeHtml(label)}</div>
          ${email ? `<div class="app-user-bar-email">${escapeHtml(email)}</div>` : ''}
        </div>
      </div>
      <div class="app-user-bar-actions">
        <a href="/profile.html" class="app-user-bar-link">Voice profile</a>
        <span class="app-user-bar-sep" aria-hidden="true">·</span>
        <a href="/brand.html" class="app-user-bar-link">Brand</a>
        <span class="app-user-bar-sep" aria-hidden="true">·</span>
        <button type="button" class="app-user-bar-logout">Log out</button>
      </div>
    `;

    const avWrap = bar.querySelector('.app-user-bar-avatar');
    if (photoUrl) {
      const img = document.createElement('img');
      img.className = 'app-user-bar-avatar-img';
      img.src = photoUrl;
      img.alt = '';
      img.width = 40;
      img.height = 40;
      avWrap.appendChild(img);
    } else {
      const sp = document.createElement('span');
      sp.className = 'app-user-bar-avatar-fallback';
      sp.setAttribute('aria-hidden', 'true');
      sp.textContent = initials(label, user.email);
      avWrap.appendChild(sp);
    }

    bar.querySelector('.app-user-bar-logout').addEventListener('click', logOut);
    document.body.appendChild(bar);
  }

  function renderSidebarFoot(user) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    const linkedin = sidebar.querySelector('.sidebar-linkedin');
    if (!linkedin) return;

    let foot = document.getElementById('sidebar-account-foot');
    if (!foot) {
      foot = document.createElement('div');
      foot.id = 'sidebar-account-foot';
      foot.className = 'sidebar-account-foot';
      linkedin.before(foot);
    }

    const label = user.displayName || user.email || 'Google user';
    foot.innerHTML = `
      <div class="sidebar-account-foot-inner">
        <span class="sidebar-account-foot-label">Account</span>
        <span class="sidebar-account-foot-name" title="${escapeAttr(user.email || '')}">${escapeHtml(label)}</span>
        <a href="/profile.html" class="sidebar-account-foot-link">Account settings</a>
        <button type="button" class="sidebar-account-foot-logout">Log out</button>
      </div>
    `;
    foot.querySelector('.sidebar-account-foot-logout').addEventListener('click', logOut);
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
        renderFloatingBar(user);
        renderSidebarFoot(user);
      })
      .catch(() => { /* offline */ });
  }
})();

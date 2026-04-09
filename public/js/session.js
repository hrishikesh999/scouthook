/* session.js — localStorage session management for Scouthook */

const Session = {
  _KEY: 'scouthook_session',

  save(data) {
    try {
      localStorage.setItem(this._KEY, JSON.stringify(data));
    } catch (e) {
      // Silently fail if storage is unavailable
    }
  },

  load() {
    try {
      const raw = localStorage.getItem(this._KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  clear() {
    localStorage.removeItem(this._KEY);
  }
};

function getUserId() {
  let uid = localStorage.getItem('scouthook_uid');
  if (!uid) {
    uid = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
    localStorage.setItem('scouthook_uid', uid);
  }
  return uid;
}

function getTenantId() {
  return localStorage.getItem('scouthook_tid') || 'default';
}

function apiHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-User-Id': getUserId(),
    'X-Tenant-Id': getTenantId()
  };
}

/**
 * Resolves after /api/auth/me so localStorage scouthook_uid matches the signed-in Google user.
 * Await this before load/save flows that use getUserId() in URLs or headers.
 */
window.scouthookAuthReady = (async () => {
  try {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
    const d = await r.json();
    if (d && d.user && d.user.user_id) {
      try {
        localStorage.setItem('scouthook_uid', d.user.user_id);
      } catch (e) {
        /* ignore */
      }
    }
    return d;
  } catch {
    return { ok: true, user: null };
  }
})();

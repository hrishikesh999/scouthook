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

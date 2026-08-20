/* cached-fetch.js — sessionStorage-backed fetch cache with in-flight deduplication */

(function () {
  const _inflight = new Map();
  const PREFIX = 'cf:';

  // Never cache identity. /api/auth/me is what session.js uses to (re)write
  // scouthook_uid, so a stale copy re-stamps the browser with the *previous*
  // account's user id — and every uid-scoped cache entry below then looks
  // legitimately fresh. Caching the answer to "who am I?" is what let a signed-out
  // test account's plan render on the next account signed in from the same tab.
  const NEVER_CACHE = ['/api/auth/me'];

  // sessionStorage survives logout→login inside the same tab, so an entry is only
  // safe to serve to the account that stored it. Entries are stamped with the uid
  // that was signed in at write time; a mismatch (or an unstamped legacy entry)
  // is a miss, not a hit. Fails toward an extra network call, never toward
  // showing one account another account's data.
  function currentUid() {
    try { return localStorage.getItem('scouthook_uid') || ''; } catch { return ''; }
  }

  function cachedFetch(url, fetchOptions, ttlMs) {
    if (ttlMs === undefined) ttlMs = 300_000; // 5-minute default
    const key = PREFIX + url;
    const uid = currentUid();
    const cacheable = !NEVER_CACHE.includes(url);

    // Return cached value if still fresh AND stored by the account now signed in
    if (cacheable) {
      try {
        const raw = sessionStorage.getItem(key);
        if (raw) {
          const entry = JSON.parse(raw);
          if (entry.uid === uid && Date.now() - entry.ts < ttlMs) {
            return Promise.resolve(entry.data);
          }
          sessionStorage.removeItem(key); // stale, or another account's — drop it
        }
      } catch { /* ignore parse errors */ }
    }

    // Return the in-flight promise if already fetching this URL
    if (_inflight.has(url)) return _inflight.get(url);

    const promise = fetch(url, fetchOptions || { credentials: 'same-origin' })
      .then(r => r.json())
      .then(data => {
        if (cacheable) {
          try {
            sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), uid, data }));
          } catch { /* ignore storage quota errors */ }
        }
        return data;
      })
      .finally(() => _inflight.delete(url));

    _inflight.set(url, promise);
    return promise;
  }

  cachedFetch.bust = function (url) {
    try { sessionStorage.removeItem(PREFIX + url); } catch { /* ignore */ }
  };

  cachedFetch.bustAll = function () {
    _inflight.clear();
    try {
      Object.keys(sessionStorage)
        .filter(k => k.startsWith(PREFIX))
        .forEach(k => sessionStorage.removeItem(k));
    } catch { /* ignore */ }
  };

  window.cachedFetch = cachedFetch;
})();

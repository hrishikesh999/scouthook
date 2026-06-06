/* cached-fetch.js — sessionStorage-backed fetch cache with in-flight deduplication */

(function () {
  const _inflight = new Map();
  const PREFIX = 'cf:';

  function cachedFetch(url, fetchOptions, ttlMs) {
    if (ttlMs === undefined) ttlMs = 300_000; // 5-minute default
    const key = PREFIX + url;

    // Return cached value if still fresh
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const entry = JSON.parse(raw);
        if (Date.now() - entry.ts < ttlMs) {
          return Promise.resolve(entry.data);
        }
      }
    } catch { /* ignore parse errors */ }

    // Return the in-flight promise if already fetching this URL
    if (_inflight.has(url)) return _inflight.get(url);

    const promise = fetch(url, fetchOptions || { credentials: 'same-origin' })
      .then(r => r.json())
      .then(data => {
        try {
          sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
        } catch { /* ignore storage quota errors */ }
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
    try {
      Object.keys(sessionStorage)
        .filter(k => k.startsWith(PREFIX))
        .forEach(k => sessionStorage.removeItem(k));
    } catch { /* ignore */ }
  };

  window.cachedFetch = cachedFetch;
})();

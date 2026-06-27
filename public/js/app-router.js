/* app-router.js — SPA-lite client-side router */

(function () {

  // Pages that participate in SPA navigation.
  // pathname → external script to (re-)load on each visit, or null if no page JS file.
  // Pages omitted here fall back to hard navigation (e.g. generate.html, media.js, brand.js
  // have module-level const DOM references that cannot be safely re-executed).
  const PAGE_SCRIPTS = {
    '/dashboard.html':  '/js/dashboard.js',
    '/vault.html':      null,
    '/drafts.html':     '/js/drafts.js',
    '/schedule.html':   '/js/schedule.js',
    '/Published.html':  '/js/published.js',
    '/settings.html':   '/js/settings.js',
    '/account.html':    null,
    '/billing.html':    null,
    '/workspaces.html': null,
    '/members.html':    '/js/members.js',
    '/linkedin.html':   null,
    '/media.html':      null,
    '/workspace.html':  '/js/members.js',
    '/post.html':       '/js/post.js',
    '/help.html':       null,
    '/voice-dna.html':  null,
  };

  // Scripts shared across all pages — never re-inject these
  const SHARED_SCRIPTS = new Set([
    '/js/cached-fetch.js',
    '/js/sidebar.js',
    '/js/session.js',
    '/js/ui-toast.js',
    '/js/account-bar.js',
    '/js/pricing-modal.js',
    '/js/feedback-widget.js',
    '/js/confetti.min.js',
    '/js/app-router.js',
  ]);

  // Track which page scripts have already been injected this session
  const _loadedScripts = new Set();

  // Capture each page's __pageInit keyed by script src so re-visits call the right init
  const _pageInitFns = new Map();

  // In-flight prefetch promises keyed by API URL — consumed once by the page script
  const _prefetches = new Map();

  // Expose a consume helper so page scripts can pick up a prefetched response
  // without re-fetching. Deletes the entry so it's used at most once.
  window.__routerConsumePrefetch = function (apiUrl) {
    const p = _prefetches.get(apiUrl);
    _prefetches.delete(apiUrl);
    return p || null;
  };

  // Pages whose primary API call uses cachedFetch — warm the cache at click-time
  // so init() finds the data ready or in-flight (cachedFetch deduplicates).
  const ROUTE_PREFETCHES = {
    '/drafts.html':    () => cachedFetch('/api/posts',                    { credentials: 'same-origin' }, 60_000),
    '/Published.html': () => cachedFetch('/api/posts?status=published',   { credentials: 'same-origin' }, 60_000),
    '/schedule.html':  () => cachedFetch('/api/linkedin/scheduled',       { credentials: 'same-origin' }, 60_000),
  };

  // Monotonic nav index for direction detection
  let _navIndex = 0;

  function isReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function getPathname(url) {
    try { return new URL(url, location.origin).pathname; } catch { return null; }
  }

  function isInternalAppUrl(url) {
    try {
      const u = new URL(url, location.origin);
      return u.origin === location.origin && u.pathname in PAGE_SCRIPTS;
    } catch { return false; }
  }

  // Update sidebar active link without re-rendering the sidebar
  const ACTIVE_OVERRIDES = {
    '/brand.html':     '/settings.html',
    '/members.html':   '/settings.html',
    '/linkedin.html':  '/settings.html',
    '/media.html':     '/settings.html',
    '/Media.html':     '/settings.html',
    '/workspace.html': '/settings.html',
    '/voice-dna.html': '/settings.html',
    '/account.html':   null,
    '/billing.html':   null,
    '/workspaces.html': null,
    '/schedule.html':  '/drafts.html',
    '/Published.html': '/drafts.html',
    '/post.html':      '/drafts.html',
  };

  function updateSidebarActiveLink(pathname) {
    const target = pathname in ACTIVE_OVERRIDES ? ACTIVE_OVERRIDES[pathname] : pathname;
    document.querySelectorAll('.sidebar-link').forEach(a => {
      const linkPath = getPathname(a.href);
      const isActive = target !== null && linkPath === target;
      a.classList.toggle('active', isActive);
      if (isActive) {
        a.setAttribute('aria-current', 'page');
      } else {
        a.removeAttribute('aria-current');
      }
    });

    // Update sidebar account link active state
    const accountLink = document.querySelector('.sidebar-account-foot-link-row');
    if (accountLink) {
      accountLink.classList.toggle('sidebar-account-foot--active', target === null);
    }
  }

  // Re-execute inline <script> elements.
  // Wrap in an IIFE so top-level const/let don't conflict on re-visits.
  function executeInlineScripts(scripts) {
    scripts.forEach(old => {
      if (old.src) return; // skip src-based scripts
      const s = document.createElement('script');
      s.textContent = `;(function(){\n${old.textContent}\n})();`;
      document.body.appendChild(s);
      s.remove(); // clean up after execution
    });
  }

  // Inject a new <link rel="stylesheet"> if not already present
  function ensureStylesheet(href) {
    const absHref = new URL(href, location.origin).pathname;
    const existing = document.querySelectorAll('link[rel="stylesheet"]');
    for (const link of existing) {
      if (getPathname(link.href) === absHref) return Promise.resolve();
    }
    return new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', resolve, { once: true }); // don't block on CSS errors
      document.head.appendChild(link);
    });
  }

  async function navigate(url, { replace = false, isPopState = false } = {}) {
    const pathname = getPathname(url);
    if (!pathname || !(pathname in PAGE_SCRIPTS)) {
      window.location.href = url;
      return;
    }

    // Same page navigation — skip
    if (pathname === location.pathname && url === location.href) return;

    // Run cleanup for current page
    if (typeof window.__pageCleanup === 'function') {
      window.__pageCleanup();
      window.__pageCleanup = null;
    }

    // Set direction for CSS animation
    document.documentElement.dataset.navDir = isPopState ? 'back' : 'forward';

    // Fire data prefetches immediately — parallel with the HTML fetch below.
    // List pages use cachedFetch (deduplicates in-flight requests automatically).
    // Post detail uses _prefetches map, consumed once by post.js init().
    ROUTE_PREFETCHES[pathname]?.();
    if (pathname === '/post.html') {
      const id = new URL(url, location.origin).searchParams.get('id');
      if (id) {
        const apiUrl = `/api/posts/${id}`;
        if (!_prefetches.has(apiUrl)) {
          _prefetches.set(apiUrl,
            fetch(apiUrl, { credentials: 'same-origin' })
              .then(r => r.json())
              .catch(() => null)
          );
        }
      }
    }

    // Fetch the new page HTML first — only push history on success
    let html;
    try {
      const res = await fetch(url, {
        credentials: 'same-origin',
        headers: { 'X-SPA-Request': '1' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch {
      // Hard navigate on network error
      window.location.href = url;
      return;
    }

    // Push/replace history state after successful fetch
    const idx = ++_navIndex;
    if (replace) {
      history.replaceState({ url, idx }, '', url);
    } else {
      history.pushState({ url, idx }, '', url);
    }

    // Parse fetched HTML
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Extract new main content
    const newContent = doc.getElementById('main-content');
    if (!newContent) {
      window.location.href = url;
      return;
    }

    // Ensure any page-specific CSS is loaded before swapping
    const newLinks = doc.querySelectorAll('link[rel="stylesheet"]');
    await Promise.all(Array.from(newLinks).map(link => ensureStylesheet(link.getAttribute('href'))));

    // Collect inline scripts from the fetched document body (page-specific logic)
    const inlineScripts = Array.from(doc.body.querySelectorAll('script:not([src])'));

    // Update page title
    document.title = doc.title;

    // Swap content with View Transitions or CSS class fallback
    const swap = () => {
      const current = document.getElementById('main-content');
      if (current) current.replaceWith(newContent);
      window.scrollTo(0, 0);
    };

    if (document.startViewTransition && !isReducedMotion()) {
      // The swap callback runs synchronously — new DOM is in place immediately after this call.
      // Don't await .finished; start page init in parallel with the visual animation.
      document.startViewTransition(swap);
    } else {
      newContent.classList.add('spa-entering');
      swap();
      newContent.addEventListener('animationend', () => {
        newContent.classList.remove('spa-entering');
      }, { once: true });
    }

    // Update sidebar active state
    updateSidebarActiveLink(pathname);

    // Re-run page header actions (help link) for the new page
    if (typeof window._renderPageHeaderActions === 'function') {
      window._renderPageHeaderActions();
    }

    // Execute page-specific inline scripts (vault.html, billing.html, account.html, etc.)
    executeInlineScripts(inlineScripts);

    // Load or re-init the page-specific script
    const scriptSrc = PAGE_SCRIPTS[pathname];
    if (scriptSrc) {
      if (_loadedScripts.has(scriptSrc)) {
        // Already loaded — call the init captured for THIS script, not the global
        const fn = _pageInitFns.get(scriptSrc);
        if (typeof fn === 'function') {
          fn();
        } else if (typeof window.__pageInit === 'function') {
          window.__pageInit();
        }
      } else {
        // First visit — inject the script (it will call init itself)
        _loadedScripts.add(scriptSrc);
        const s = document.createElement('script');
        s.src = scriptSrc;
        s.addEventListener('load', () => {
          if (typeof window.__pageInit === 'function') {
            _pageInitFns.set(scriptSrc, window.__pageInit);
          }
        }, { once: true });
        document.body.appendChild(s);
      }
    }

    // Notify analytics or other listeners
    document.dispatchEvent(new CustomEvent('spa:navigated', { detail: { url, pathname } }));
  }

  // Intercept clicks on internal links
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const a = e.target.closest('a[href]');
    if (!a) return;
    if (a.target === '_blank') return;
    if (a.hasAttribute('download')) return;
    if (a.hasAttribute('data-no-spa')) return;

    const url = a.href;
    if (!isInternalAppUrl(url)) return;

    e.preventDefault();
    navigate(url);
  });

  // Handle browser back/forward
  window.addEventListener('popstate', e => {
    const url = (e.state && e.state.url) || location.href;
    navigate(url, { replace: true, isPopState: true });
  });

  // Initialise history state for the current page so popstate has a url to work with
  history.replaceState({ url: location.href, idx: _navIndex }, '', location.href);

  // Mark current page script as already loaded and capture its init
  const currentScript = PAGE_SCRIPTS[location.pathname];
  if (currentScript) {
    _loadedScripts.add(currentScript);
    // Capture __pageInit after all synchronous scripts have executed.
    // setTimeout(0) queues a macrotask that runs after the page script sets __pageInit.
    // (Promise.resolve microtasks fire between scripts — too early.)
    setTimeout(() => {
      if (typeof window.__pageInit === 'function' && !_pageInitFns.has(currentScript)) {
        _pageInitFns.set(currentScript, window.__pageInit);
      }
    }, 0);
  }

})();

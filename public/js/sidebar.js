/* sidebar.js — shared sidebar component, auto-injected into every app page */

(function () {
  // Inject Calendly dependencies once
  if (!document.getElementById('calendly-css')) {
    var cl = document.createElement('link');
    cl.id   = 'calendly-css';
    cl.rel  = 'stylesheet';
    cl.href = 'https://assets.calendly.com/assets/external/widget.css';
    document.head.appendChild(cl);
  }
  if (!document.getElementById('calendly-js')) {
    var cs = document.createElement('script');
    cs.id   = 'calendly-js';
    cs.src  = 'https://assets.calendly.com/assets/external/widget.js';
    cs.type = 'text/javascript';
    cs.async = true;
    document.head.appendChild(cs);
  }

  // Pages that activate a nav link other than their own href
  var activeOverrides = {
    '/account.html':   '/settings.html',
    '/billing.html':   '/settings.html',
    '/brand.html':     '/settings.html',
    '/editor.html':    '/posts.html',
    '/drafts.html':    '/posts.html',
    '/schedule.html':  '/posts.html',
    '/Published.html': '/posts.html',
  };

  var pathname = window.location.pathname;
  var activeHref = activeOverrides[pathname] || pathname;

  function link(href, svg, label) {
    var isActive = activeHref === href;
    var cls = 'sidebar-link' + (isActive ? ' active' : '');
    var aria = isActive ? ' aria-current="page"' : '';
    return '<a href="' + href + '" class="' + cls + '"' + aria + '>' + svg + label + '</a>';
  }

  var svgDashboard = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  var svgVault     = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
  var svgPosts     = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
  var svgMedia     = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
  var svgSettings  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  var svgCalendly  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M8 14h.01M12 14h.01M16 14h.01"/></svg>';
  var svgPlus      = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  var CALENDLY_URL = 'https://calendly.com/contact-scouthook/scouthook';

  var html = [
    '<aside id="sidebar" role="navigation" aria-label="Main navigation">',
    '  <a href="/dashboard.html" class="sidebar-logo">',
    '    <img src="/images/scout-hook-logo.png" alt="ScoutHook" class="sidebar-logo-img">',
    '  </a>',
    '  <div class="sidebar-cta">',
    '    <a href="/generate.html?new=1" class="sidebar-cta-btn">' + svgPlus + 'Create Post</a>',
    '  </div>',
    '  <nav class="sidebar-nav">',
    '    ' + link('/dashboard.html', svgDashboard, 'Dashboard'),
    '    ' + link('/vault.html',     svgVault,     'Idea Vault'),
    '    ' + link('/posts.html',     svgPosts,     'Posts'),
    '    ' + link('/Media.html',     svgMedia,     'Media'),
    '  </nav>',
    '  <div class="sidebar-bottom">',
    '    ' + link('/settings.html', svgSettings, 'Settings'),
    '    <div id="sidebar-account-slot" aria-label="Signed-in account"></div>',
    '    <a href="" id="sidebar-calendly-btn" class="sidebar-help-link">' + svgCalendly + 'Book onboarding call</a>',
    '  </div>',
    '</aside>',
  ].join('\n');

  var el = document.createElement('div');
  el.innerHTML = html;
  var aside = el.firstChild;
  document.body.insertBefore(aside, document.body.firstChild);

  // Wire Calendly button — lazy-loads the script on first click if not ready yet
  var calendlyBtn = document.getElementById('sidebar-calendly-btn');
  if (calendlyBtn) {
    calendlyBtn.addEventListener('click', function (e) {
      e.preventDefault();
      function openCalendly() {
        window.Calendly.initPopupWidget({ url: CALENDLY_URL });
      }
      if (window.Calendly) {
        openCalendly();
      } else {
        var s = document.createElement('script');
        s.src = 'https://assets.calendly.com/assets/external/widget.js';
        s.type = 'text/javascript';
        s.onload = openCalendly;
        document.head.appendChild(s);
      }
    });
  }
})();

/* sidebar.js — shared sidebar component, auto-injected into every app page */

(function () {
  // Pages that activate a nav link other than their own href
  var activeOverrides = {
    '/brand.html':      '/settings.html',
    '/members.html':    '/settings.html',
    '/linkedin.html':   '/settings.html',
    '/media.html':      '/settings.html',
    '/Media.html':      '/settings.html',
    '/workspace.html':  '/settings.html',
    '/account.html':    null,
    '/billing.html':    null,
    '/workspaces.html': null,
    '/editor.html':     '/drafts.html',
    '/schedule.html':   '/drafts.html',
    '/published.html':  '/drafts.html',
  };

  var pathname = window.location.pathname;
  var activeHref = pathname in activeOverrides ? activeOverrides[pathname] : pathname;

  function link(href, svg, label) {
    var isActive = activeHref === href;
    var cls = 'sidebar-link' + (isActive ? ' active' : '');
    var aria = isActive ? ' aria-current="page"' : '';
    return '<a href="' + href + '" class="' + cls + '"' + aria + '>' + svg + label + '</a>';
  }

  var svgDashboard = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  var svgVault     = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
  var svgDrafts    = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
  var svgSchedule  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
  var svgPublished = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  var svgMedia     = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
  var svgSettings  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  var svgPlus      = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  var html = [
    '<aside id="sidebar" role="navigation" aria-label="Main navigation">',
    '  <a href="/dashboard.html" class="sidebar-logo">',
    '    <img src="/images/scout-hook-logo.png" alt="ScoutHook" class="sidebar-logo-img">',
    '  </a>',
    '  <div id="workspace-switcher-slot"></div>',
    '  <div class="sidebar-cta">',
    '    <a href="/generate.html?new=1" class="sidebar-cta-btn">' + svgPlus + 'Create Post</a>',
    '  </div>',
    '  <nav class="sidebar-nav">',
    '    ' + link('/dashboard.html', svgDashboard, 'Dashboard'),
    '    ' + link('/drafts.html',    svgDrafts,    'Posts'),
    '    ' + link('/vault.html',     svgVault,     'Knowledge Vault'),
    '    ' + link('/settings.html',  svgSettings,  'Settings'),
    '  </nav>',
    '  <div class="sidebar-bottom">',
    '    <div id="sidebar-account-slot" aria-label="Signed-in account"></div>',
    '  </div>',
    '</aside>',
  ].join('\n');

  var el = document.createElement('div');
  el.innerHTML = html;
  var aside = el.firstChild;
  document.body.insertBefore(aside, document.body.firstChild);

  // ── Mobile top bar (visible only on ≤768px via CSS) ─────────
  var svgHamburger = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';

  var topbarEl = document.createElement('div');
  topbarEl.id = 'mobile-topbar';
  topbarEl.innerHTML = [
    '<a href="/dashboard.html" class="mobile-logo-link">',
    '  <img src="/images/scout-hook-logo.png" alt="ScoutHook" class="sidebar-logo-img">',
    '</a>',
    '<div class="mobile-topbar-right">',
    '  <a href="/generate.html?new=1" class="mobile-create-btn">' + svgPlus + ' Create Post</a>',
    '  <button type="button" id="mobile-menu-toggle" aria-label="Open navigation" aria-expanded="false">',
    '    ' + svgHamburger,
    '  </button>',
    '</div>',
  ].join('');
  document.body.insertBefore(topbarEl, aside.nextSibling);

  var backdropEl = document.createElement('div');
  backdropEl.id = 'sidebar-backdrop';
  backdropEl.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(backdropEl, topbarEl.nextSibling);

  // ── Hamburger toggle ─────────────────────────────────────────
  var menuToggle = topbarEl.querySelector('#mobile-menu-toggle');

  function openMenu() {
    aside.classList.add('mobile-open');
    backdropEl.classList.add('visible');
    menuToggle.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }

  function closeMenu() {
    aside.classList.remove('mobile-open');
    backdropEl.classList.remove('visible');
    menuToggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  menuToggle.addEventListener('click', function () {
    aside.classList.contains('mobile-open') ? closeMenu() : openMenu();
  });

  backdropEl.addEventListener('click', closeMenu);

  aside.querySelectorAll('.sidebar-link').forEach(function (link) {
    link.addEventListener('click', closeMenu);
  });

})();

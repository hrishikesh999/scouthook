/* settings-nav.js — context-aware settings tab navigation
   User-level pages show account tabs; workspace-level pages show workspace tabs.
   Loaded once (dedup guard) and re-injects on SPA navigations via spa:navigated. */
if (!window._settingsNavLoaded) {
  window._settingsNavLoaded = true;

  var _USER_TABS = [
    { label: 'Profile',      href: '/account.html' },
    { label: 'Subscription', href: '/billing.html' },
    { label: 'Workspaces',   href: '/workspaces.html' },
  ];

  var _WORKSPACE_TABS = [
    { label: 'Brand voice',    href: '/settings.html' },
    { label: 'Brand settings', href: '/brand.html' },
    { label: 'Members',        href: '/members.html' },
    { label: 'LinkedIn',       href: '/linkedin.html' },
    { label: 'Media',          href: '/media.html' },
  ];

  var _USER_PATHS = {};
  _USER_TABS.forEach(function (t) { _USER_PATHS[t.href] = true; });
  var _WORKSPACE_PATHS = {};
  _WORKSPACE_TABS.forEach(function (t) { _WORKSPACE_PATHS[t.href] = true; });

  function _injectSettingsNav() {
    var placeholder = document.getElementById('settings-nav');
    if (!placeholder) return;

    var current = window.location.pathname;
    var isUserContext = current in _USER_PATHS;
    var tabs = isUserContext ? _USER_TABS : _WORKSPACE_TABS;

    var wrapper = document.createElement('div');
    wrapper.className = 'settings-nav-wrapper';

    // Context heading
    var heading = document.createElement('div');
    heading.className = 'settings-nav-heading';
    if (isUserContext) {
      heading.textContent = 'My account';
    } else {
      heading.textContent = 'Workspace settings';
      // Try to get workspace name from sidebar switcher
      var wsName = document.querySelector('.ws-sw-name');
      if (wsName && wsName.textContent) {
        heading.textContent = wsName.textContent + ' settings';
      } else {
        // Retry after auth resolves
        var auth = window.scouthookAuthReady;
        if (auth && typeof auth.then === 'function') {
          auth.then(function () {
            var wsEl = document.querySelector('.ws-sw-name');
            if (wsEl && wsEl.textContent) heading.textContent = wsEl.textContent + ' settings';
          }).catch(function () {});
        }
      }
    }
    wrapper.appendChild(heading);

    var nav = document.createElement('nav');
    nav.className = 'account-tabs';
    nav.setAttribute('aria-label', isUserContext ? 'Account settings' : 'Workspace settings');

    tabs.forEach(function (tab) {
      var a = document.createElement('a');
      a.href = tab.href;
      a.className = 'account-tab';
      a.textContent = tab.label;
      var tabPath = new URL(tab.href, window.location.origin).pathname;
      if (tabPath === current) {
        a.classList.add('active');
        a.setAttribute('aria-current', 'page');
      }
      nav.appendChild(a);
    });

    wrapper.appendChild(nav);
    placeholder.replaceWith(wrapper);
  }

  _injectSettingsNav();
  document.addEventListener('spa:navigated', _injectSettingsNav);
}

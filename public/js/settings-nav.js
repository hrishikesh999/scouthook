/* settings-nav.js — shared account-section navigation tabs */
(function () {
  var tabs = [
    { label: 'Brand voice',    href: '/settings.html' },
    { label: 'My account',     href: '/account.html' },
    { label: 'Brand settings', href: '/brand.html' },
    { label: 'Members',        href: '/members.html' },
    { label: 'Subscription',   href: '/billing.html' },
  ];

  var current = window.location.pathname;

  var nav = document.createElement('nav');
  nav.className = 'account-tabs';
  nav.setAttribute('aria-label', 'Account settings');

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

  var placeholder = document.getElementById('settings-nav');
  if (placeholder) placeholder.replaceWith(nav);
})();

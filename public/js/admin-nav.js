(function() {
  const NAV_HTML = `
    <nav class="admin-nav">
      <a href="/admin.html" class="admin-nav__brand">
        <img src="/images/sh-logo-dark.png" alt="ScoutHook" class="admin-nav__logo" />
        <span>Admin</span>
      </a>
      <div class="admin-nav__links">
        <a href="/admin.html" class="admin-nav__link">Dashboard</a>
        <a href="/admin-users.html" class="admin-nav__link">Users</a>
        <a href="/admin-feedback.html" class="admin-nav__link">Feedback</a>
        <a href="/admin-support.html" class="admin-nav__link">Support</a>
        <div class="admin-nav__sep"></div>
        <a href="/admin-settings.html" class="admin-nav__link">Settings</a>
        <a href="/admin-templates.html" class="admin-nav__link">Templates</a>
        <a href="/admin-html-templates.html" class="admin-nav__link">HTML Templates</a>
      </div>
      <div class="admin-nav__bottom">
        <a href="/admin-logout.html" class="admin-nav__logout">Log out</a>
      </div>
    </nav>`;

  function initNav() {
    const container = document.getElementById('admin-nav-container');
    if (!container) return;
    container.innerHTML = NAV_HTML;
    const current = window.location.pathname;
    container.querySelectorAll('.admin-nav__link[href]').forEach(function(link) {
      if (link.getAttribute('href') === current) {
        link.classList.add('admin-nav__link--active');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
})();

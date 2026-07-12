/* ideas-pill.js — global Ideas pill (Idea Engine Phase 2, spec R8)
 *
 * A floating ✨ button on every app page that opens a slide-over drawer with
 * the same Daily 3 the dashboard serves (idea-cards.js renders both). No
 * algorithmic shuffle — the shuffle button just rotates the same 3 cards.
 *
 * Data flows through cachedFetch('/api/ideas/today') with a 1-hour TTL
 * (sprint decision: re-open re-fetches if >1hr old); card actions bust the
 * cache via idea-cards.js. Drawer closes on SPA navigation.
 */

(function () {
  'use strict';

  if (window.__ideasPillMounted) return;
  window.__ideasPillMounted = true;

  var TODAY_URL = '/api/ideas/today';
  var TTL_MS = 60 * 60 * 1000;

  /* ── DOM scaffold (button + dialog live outside #main-content) ── */
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'ideas-pill';
  btn.className = 'ideas-pill';
  btn.setAttribute('aria-label', 'Open today\'s ideas');
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 3l1.7 4.6L18.3 9.3l-4.6 1.7L12 15.6l-1.7-4.6L5.7 9.3l4.6-1.7z"/>' +
      '<path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>' +
    '</svg>' +
    '<span id="ideas-pill-badge" class="ideas-pill-badge" hidden></span>';

  var dlg = document.createElement('dialog');
  dlg.id = 'ideas-drawer';
  dlg.className = 'ideas-drawer';
  dlg.setAttribute('aria-label', 'Today\'s ideas');
  dlg.innerHTML =
    '<div class="ideas-drawer-header">' +
      '<div>' +
        '<h2 class="ideas-drawer-title">Today\'s ideas</h2>' +
        '<p class="ideas-drawer-sub">Same three as your dashboard — act on one.</p>' +
      '</div>' +
      '<div class="ideas-drawer-header-actions">' +
        '<button type="button" id="ideas-drawer-shuffle" class="ti-ghost-btn" aria-label="Shuffle card order">Shuffle</button>' +
        '<button type="button" id="ideas-drawer-close" class="ideas-drawer-close" aria-label="Close">&times;</button>' +
      '</div>' +
    '</div>' +
    '<div id="ideas-drawer-cards" class="ideas-drawer-cards" aria-live="polite"></div>' +
    '<div class="ideas-drawer-foot">' +
      '<a href="/ideas.html">Your saved queue →</a>' +
      '<a href="/dashboard.html">Dashboard →</a>' +
    '</div>';

  document.body.appendChild(btn);
  document.body.appendChild(dlg);

  var cardsEl   = dlg.querySelector('#ideas-drawer-cards');
  var badgeEl   = btn.querySelector('#ideas-pill-badge');
  var _cards    = [];

  function fetchToday() {
    if (typeof cachedFetch !== 'function') return Promise.resolve(null);
    return cachedFetch(TODAY_URL, { credentials: 'same-origin' }, TTL_MS).catch(function () { return null; });
  }

  function freshCount(cards) {
    var n = 0;
    (cards || []).forEach(function (c) { if (c.status === 'served') n++; });
    return n;
  }

  function updateBadge() {
    var n = freshCount(_cards);
    badgeEl.textContent = String(n);
    badgeEl.hidden = n === 0;
  }

  function renderCards() {
    if (!window.ScoutIdeaCards) return;
    cardsEl.innerHTML = '';
    if (!_cards.length) {
      cardsEl.innerHTML =
        '<div class="ti-empty">That\'s all for today — fresh ideas tomorrow. ' +
        '<a href="/generate.html?new=1">Or write your own →</a></div>';
      return;
    }
    _cards.forEach(function (card) {
      cardsEl.appendChild(window.ScoutIdeaCards.buildCard(card, {
        mode: 'today',
        onRemoved: function () {
          _cards = _cards.filter(function (c) { return String(c.id) !== String(card.id); });
          updateBadge();
          if (!_cards.length) renderCards();
        },
      }));
    });
  }

  function loadIntoDrawer() {
    cardsEl.innerHTML = '<div class="ti-empty">Fetching today\'s ideas…</div>';
    fetchToday().then(function (data) {
      _cards = (data && data.ok && Array.isArray(data.cards)) ? data.cards : [];
      updateBadge();
      renderCards();
    });
  }

  function openDrawer() {
    if (dlg.open) return;
    dlg.showModal();
    loadIntoDrawer();
  }

  function closeDrawer() {
    if (dlg.open) dlg.close();
  }

  btn.addEventListener('click', openDrawer);
  dlg.querySelector('#ideas-drawer-close').addEventListener('click', closeDrawer);

  // One visual rotation per tap — same 3 cards, different order (no new fetch)
  dlg.querySelector('#ideas-drawer-shuffle').addEventListener('click', function () {
    if (_cards.length < 2) return;
    _cards.push(_cards.shift());
    renderCards();
  });

  // Click on the backdrop closes (the dialog element itself is the click target)
  dlg.addEventListener('click', function (e) {
    if (e.target === dlg) closeDrawer();
  });

  // Close when the SPA router swaps pages
  document.addEventListener('spa:navigated', closeDrawer);

  // Badge on page load — cheap after the first page thanks to the shared cache
  fetchToday().then(function (data) {
    if (data && data.ok && Array.isArray(data.cards)) {
      _cards = data.cards;
      updateBadge();
    }
  });
})();

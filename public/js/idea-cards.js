/* idea-cards.js — shared idea-card renderer (Idea Engine Phase 2)
 *
 * One card builder used by three surfaces:
 *   - dashboard "Today's 3" zone   (mode: 'today')
 *   - global Ideas pill drawer      (mode: 'today')
 *   - Ideas tab saved queue         (mode: 'queue')
 *
 * mode 'today': Write this → / Save / Not for me (dismiss)
 * mode 'queue': Write this → / Remove (archive — soft-delete out of the queue)
 * Question cards always use the answer flow (Answer → textarea → save & draft).
 *
 * Loaded as a shared script on every app page (before dashboard.js/ideas-pill.js).
 */

(function () {
  'use strict';

  var TYPE_META = {
    reach:       { label: 'Reach',       cls: 'ti-type-reach' },
    trust:       { label: 'Authority',   cls: 'ti-type-trust' },
    convert:     { label: 'Convert',     cls: 'ti-type-convert' },
    lead_magnet: { label: 'Lead magnet', cls: 'ti-type-lead' },
  };
  // generate.html CHAT_CONFIGS has no 'lead_magnet' key — its guided flow is 'lead_gen'
  var URL_TYPE = { reach: 'reach', trust: 'trust', convert: 'convert', lead_magnet: 'lead_gen' };

  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function headers() {
    return typeof apiHeaders === 'function' ? apiHeaders() : {};
  }

  var ICON_DISMISS = '<svg class="ti-btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  var ICON_REMOVE = '<svg class="ti-btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
  var ICON_PERSON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

  // The LinkedIn identity a card's "Write this" would publish under — fetched
  // once per page load and shared across every card via cachedFetch's own cache.
  var profilePromise = null;
  function getProfile() {
    if (!profilePromise) {
      profilePromise = (window.cachedFetch
        ? cachedFetch('/api/linkedin/status', { credentials: 'same-origin' }, 120_000)
        : Promise.resolve(null)).catch(function () { return null; });
    }
    return profilePromise;
  }

  /* Card header: avatar + display name (patched in async) + a type/source tag */
  function cardHeadHtml(tagHtml, provenanceText) {
    return '<div class="ti-card-head">' +
      '<div class="ti-card-avatar" data-role="avatar">' + ICON_PERSON + '</div>' +
      '<div class="ti-card-head-text">' +
        '<div class="ti-card-head-top">' +
          '<span class="ti-card-name" data-role="name">You</span>' +
          tagHtml +
        '</div>' +
        (provenanceText ? '<p class="ti-provenance">' + provenanceText + '</p>' : '') +
      '</div>' +
    '</div>';
  }

  function attachProfile(el) {
    getProfile().then(function (p) {
      if (!p || !p.connected) return;
      var nameEl = el.querySelector('[data-role="name"]');
      var avEl   = el.querySelector('[data-role="avatar"]');
      if (nameEl && p.name) nameEl.textContent = p.name;
      if (avEl) {
        if (p.photo_url) {
          var img = document.createElement('img');
          img.src           = p.photo_url.trim();
          img.alt           = p.name || '';
          img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%';
          avEl.innerHTML = '';
          avEl.appendChild(img);
        } else if (p.name) {
          avEl.textContent = p.name.charAt(0).toUpperCase();
        }
      }
    });
  }

  // Any card mutation invalidates the cached card sets + sidebar badge
  function queueChanged() {
    if (window.cachedFetch && cachedFetch.bust) {
      cachedFetch.bust('/api/ideas/queue');
      cachedFetch.bust('/api/ideas/today');
    }
    if (typeof window.__refreshIdeasBadge === 'function') window.__refreshIdeasBadge();
  }

  function writeUrl(card, ideaText) {
    var params = new URLSearchParams({
      type: URL_TYPE[card.post_type] || 'reach',
      idea: ideaText,
      idea_card: String(card.id),
    });
    return '/generate.html?' + params.toString();
  }

  /* Write this → funnel marker + hand-off to the generator, fully prefilled */
  function goWrite(card) {
    fetch('/api/ideas/' + card.id + '/clicked', { method: 'POST', headers: headers() }).catch(function () {});
    queueChanged(); // the generation will change this card's status
    window.location.href = writeUrl(card, card.textarea_input || card.hook);
  }

  /**
   * buildCard(card, opts) → HTMLElement
   * opts:
   *   mode      'today' (default) | 'queue'
   *   onRemoved (el) — called after a card is dismissed/archived and removed
   */
  function buildCard(card, opts) {
    opts = opts || {};
    var mode = opts.mode === 'queue' ? 'queue' : 'today';

    if (card.is_question) return buildQuestionCard(card, opts);

    var meta = TYPE_META[card.post_type] || TYPE_META.reach;
    var el = document.createElement('div');
    el.className = 'ti-card';
    el.dataset.id = card.id;

    // 'today' (dashboard + pill drawer): one clear labelled CTA plus two compact
    // icon buttons — three labelled buttons don't fit the card width and wrap.
    // 'queue' (Ideas tab): only two buttons, so keep the "Remove" label.
    var secondary = mode === 'queue'
      ? '<button class="ti-ghost-btn ti-remove-btn" type="button" aria-label="Remove from queue">' + ICON_REMOVE + '<span>Remove</span></button>'
      : '<button class="ti-ghost-btn ti-ghost-btn--sm ti-save-btn" type="button" title="Save for later" aria-label="Save for later"' + (card.status === 'saved' ? ' disabled' : '') + '>' + (card.status === 'saved' ? 'Saved' : 'Save') + '</button>' +
        '<button class="ti-ghost-btn ti-ghost-btn--icon ti-dismiss-btn" type="button" title="Not for me" aria-label="Not for me">' + ICON_DISMISS + '</button>';

    el.innerHTML =
      cardHeadHtml('<span class="ti-type-chip ' + meta.cls + '">' + meta.label + '</span>', esc(card.provenance_label || '')) +
      '<p class="ti-hook">' + esc(card.hook) + '</p>' +
      '<div class="ti-actions">' +
        '<button class="ti-write-btn" type="button">Write this →</button>' +
        secondary +
      '</div>';

    attachProfile(el);
    el.querySelector('.ti-write-btn').addEventListener('click', function () { goWrite(card); });

    var saveBtn = el.querySelector('.ti-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', function (e) {
        var btn = e.currentTarget;
        btn.disabled = true;
        fetch('/api/ideas/' + card.id + '/save', { method: 'POST', headers: headers() })
          .then(function (r) {
            if (!r.ok) throw new Error('save_failed');
            queueChanged();
            // Saved → it now lives in the Ideas queue, so it leaves today's list
            el.classList.add('ti-card--leaving');
            setTimeout(function () {
              el.remove();
              if (typeof opts.onRemoved === 'function') opts.onRemoved(el);
            }, 180);
          })
          .catch(function () { btn.disabled = false; });
      });
    }

    function leaveAnd(endpoint) {
      el.classList.add('ti-card--leaving');
      fetch('/api/ideas/' + card.id + '/' + endpoint, { method: 'POST', headers: headers() })
        .then(queueChanged).catch(function () {});
      setTimeout(function () {
        el.remove();
        if (typeof opts.onRemoved === 'function') opts.onRemoved(el);
      }, 180);
    }

    var dismissBtn = el.querySelector('.ti-dismiss-btn');
    if (dismissBtn) dismissBtn.addEventListener('click', function () { leaveAnd('dismiss'); });
    var removeBtn = el.querySelector('.ti-remove-btn');
    if (removeBtn) removeBtn.addEventListener('click', function () { leaveAnd('archive'); });

    return el;
  }

  /* Question card — answering deposits a vault memory AND opens a prefilled draft */
  function buildQuestionCard(card, opts) {
    opts = opts || {};
    var mode = opts.mode === 'queue' ? 'queue' : 'today';
    var el = document.createElement('div');
    el.className = 'ti-card ti-card--question';
    el.dataset.id = card.id;

    if (card.status === 'answered') {
      el.innerHTML =
        cardHeadHtml('<span class="ti-type-chip ti-type-question">Today\'s question</span>', '') +
        '<p class="ti-hook">' + esc(card.hook) + '</p>' +
        '<div class="ti-actions"><span class="ti-answered-note">Answered ✓ — saved to your vault</span></div>';
      attachProfile(el);
      return el;
    }

    el.innerHTML =
      cardHeadHtml('<span class="ti-type-chip ti-type-question">' + (mode === 'queue' ? 'Question' : 'Today\'s question') + '</span>', esc(card.provenance_label || '')) +
      '<p class="ti-hook">' + esc(card.hook) + '</p>' +
      '<div class="ti-actions ti-q-initial">' +
        '<button class="ti-write-btn ti-answer-toggle" type="button">Answer →</button>' +
        '<button class="ti-ghost-btn ti-dismiss-btn" type="button">' + ICON_DISMISS + '<span>' + (mode === 'queue' ? 'Remove' : 'Not today') + '</span></button>' +
      '</div>' +
      '<div class="ti-answer-form" hidden>' +
        '<div class="ti-answer-input-wrap">' +
          '<textarea class="ti-answer-input" rows="3" placeholder="30 seconds, plain words — a specific moment, number, or opinion…" aria-label="Your answer"></textarea>' +
          '<button class="ti-mic-btn" type="button" aria-label="Record voice answer" style="display:none">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>' +
          '</button>' +
        '</div>' +
        '<p class="ti-answer-error" role="alert" hidden>A little more detail — one specific moment or number is enough.</p>' +
        '<div class="ti-actions">' +
          '<button class="ti-write-btn ti-answer-submit" type="button">Save &amp; draft post →</button>' +
          '<button class="ti-ghost-btn ti-answer-cancel" type="button">Cancel</button>' +
        '</div>' +
      '</div>';

    var initialRow = el.querySelector('.ti-q-initial');
    var form       = el.querySelector('.ti-answer-form');
    var input      = el.querySelector('.ti-answer-input');
    var errEl      = el.querySelector('.ti-answer-error');

    el.querySelector('.ti-answer-toggle').addEventListener('click', function () {
      initialRow.hidden = true;
      form.hidden = false;
      input.focus();
      if (typeof initVoiceInput === 'function') {
        initVoiceInput({ input: input, btn: el.querySelector('.ti-mic-btn') });
      }
    });

    el.querySelector('.ti-answer-cancel').addEventListener('click', function () {
      form.hidden = true;
      initialRow.hidden = false;
    });

    el.querySelector('.ti-dismiss-btn').addEventListener('click', function () {
      el.classList.add('ti-card--leaving');
      var endpoint = mode === 'queue' ? 'archive' : 'dismiss';
      fetch('/api/ideas/' + card.id + '/' + endpoint, { method: 'POST', headers: headers() })
        .then(queueChanged).catch(function () {});
      setTimeout(function () {
        el.remove();
        if (typeof opts.onRemoved === 'function') opts.onRemoved(el);
      }, 180);
    });

    el.querySelector('.ti-answer-submit').addEventListener('click', function (e) {
      var answer = input.value.trim();
      if (answer.length < 20) { errEl.hidden = false; return; }
      errEl.hidden = true;
      var btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      fetch('/api/ideas/' + card.id + '/answer', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
        body: JSON.stringify({ answer: answer }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.ok) throw new Error(data.error || 'answer_failed');
          queueChanged();
          // The answer endpoint minted this card's two follow-up questions and
          // stashed the answer — hand off into the 2-question flow (type locked,
          // no prefilled box, no picker). No idea= param: the flow owns context.
          var params = new URLSearchParams({
            type: URL_TYPE[card.post_type] || 'reach',
            idea_card: String(card.id),
          });
          window.location.href = '/generate.html?' + params.toString();
        })
        .catch(function () {
          btn.disabled = false;
          btn.textContent = 'Save & draft post →';
          errEl.textContent = 'Could not save — try again.';
          errEl.hidden = false;
        });
    });

    attachProfile(el);
    return el;
  }

  window.ScoutIdeaCards = { buildCard: buildCard, escHtml: esc, writeUrl: writeUrl };
})();

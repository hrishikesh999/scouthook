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

    var secondary = mode === 'queue'
      ? '<button class="ti-ghost-btn ti-remove-btn" type="button" aria-label="Remove from queue">Remove</button>'
      : '<button class="ti-ghost-btn ti-save-btn" type="button"' + (card.status === 'saved' ? ' disabled' : '') + '>' + (card.status === 'saved' ? 'Saved ✓' : 'Save') + '</button>' +
        '<button class="ti-ghost-btn ti-dismiss-btn" type="button" aria-label="Not for me">Not for me</button>';

    el.innerHTML =
      '<div class="ti-card-top">' +
        '<span class="ti-type-chip ' + meta.cls + '">' + meta.label + '</span>' +
        '<span class="ti-provenance">' + esc(card.provenance_label || '') + '</span>' +
      '</div>' +
      '<p class="ti-hook">' + esc(card.hook) + '</p>' +
      '<div class="ti-actions">' +
        '<button class="ti-write-btn" type="button">Write this →</button>' +
        secondary +
      '</div>';

    el.querySelector('.ti-write-btn').addEventListener('click', function () { goWrite(card); });

    var saveBtn = el.querySelector('.ti-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', function (e) {
        var btn = e.currentTarget;
        btn.disabled = true;
        fetch('/api/ideas/' + card.id + '/save', { method: 'POST', headers: headers() })
          .then(function (r) {
            if (!r.ok) throw new Error('save_failed');
            btn.textContent = 'Saved ✓';
            queueChanged();
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
        '<div class="ti-card-top">' +
          '<span class="ti-type-chip ti-type-question">Today\'s question</span>' +
        '</div>' +
        '<p class="ti-hook">' + esc(card.hook) + '</p>' +
        '<div class="ti-actions"><span class="ti-answered-note">Answered ✓ — saved to your vault</span></div>';
      return el;
    }

    el.innerHTML =
      '<div class="ti-card-top">' +
        '<span class="ti-type-chip ti-type-question">' + (mode === 'queue' ? 'Question' : 'Today\'s question') + '</span>' +
        '<span class="ti-provenance">' + esc(card.provenance_label || '') + '</span>' +
      '</div>' +
      '<p class="ti-hook">' + esc(card.hook) + '</p>' +
      '<div class="ti-actions ti-q-initial">' +
        '<button class="ti-write-btn ti-answer-toggle" type="button">Answer →</button>' +
        '<button class="ti-ghost-btn ti-dismiss-btn" type="button">' + (mode === 'queue' ? 'Remove' : 'Not today') + '</button>' +
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
          // Q+A becomes the draft's raw input — same shape as the interview path
          window.location.href = writeUrl(card, card.hook + '\n' + answer);
        })
        .catch(function () {
          btn.disabled = false;
          btn.textContent = 'Save & draft post →';
          errEl.textContent = 'Could not save — try again.';
          errEl.hidden = false;
        });
    });

    return el;
  }

  window.ScoutIdeaCards = { buildCard: buildCard, escHtml: esc, writeUrl: writeUrl };
})();

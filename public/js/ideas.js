/* ideas.js — Ideas tab: saved queue + answered questions (Idea Engine Phase 2, spec R9) */

(function () {

async function init() {
  const queueEl = document.getElementById('ideas-queue');
  if (!queueEl) return; // not on the ideas page
  await window.scouthookAuthReady;
  loadQueue();
  bindNewQuestion();
}

window.__pageInit = init;
init();

const esc = (s) => (window.ScoutIdeaCards ? window.ScoutIdeaCards.escHtml(s) : s || '');

/* ── Saved queue + answered history ──────────────────────────── */
async function loadQueue() {
  const queueEl = document.getElementById('ideas-queue');
  try {
    // cachedFetch: consumes the router prefetch; mutations bust this key in idea-cards.js
    const data = await cachedFetch('/api/ideas/queue', { credentials: 'same-origin' }, 60_000);
    if (!data || !data.ok) throw new Error('queue_unavailable');
    renderQueue(data.saved || []);
    renderAnswered(data.answered || []);
    // Refresh the sidebar badge — visiting the tab is the natural "seen" moment
    if (typeof window.__refreshIdeasBadge === 'function') window.__refreshIdeasBadge();
  } catch {
    queueEl.innerHTML = `<div class="card-empty-state">Could not load your ideas — refresh to try again.</div>`;
  }
}

function queueEmptyState() {
  return `
    <div class="card-empty-state ideas-empty">
      Nothing in your queue yet. Save ideas from your
      <a href="/dashboard.html">Today's 3</a> and they'll wait here until you're ready to write.
    </div>`;
}

function renderQueue(cards) {
  const queueEl = document.getElementById('ideas-queue');
  queueEl.innerHTML = '';
  if (!cards.length) {
    queueEl.innerHTML = queueEmptyState();
    return;
  }
  const onRemoved = () => {
    if (typeof window.__refreshIdeasBadge === 'function') window.__refreshIdeasBadge();
    if (!queueEl.querySelector('.ti-card')) queueEl.innerHTML = queueEmptyState();
  };
  cards.forEach(card => {
    queueEl.appendChild(window.ScoutIdeaCards.buildCard(card, { mode: 'queue', onRemoved }));
  });
}

/* Answered questions — each is a vault memory; "Write this" drafts from the Q+A */
function renderAnswered(items) {
  const section = document.getElementById('ideas-answered-section');
  const list    = document.getElementById('ideas-answered');
  if (!section || !list || !items.length) return;
  list.innerHTML = '';
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'ideas-answered-row';
    row.innerHTML = `
      <div class="ideas-answered-left">
        <p class="ideas-answered-q">${esc(item.question || 'Daily question')}</p>
        <p class="ideas-answered-a">${esc(item.answer || '')}</p>
      </div>
      <div class="ideas-answered-actions">
        ${item.used
          ? '<span class="ti-answered-note">Used ✓</span>'
          : '<button class="ti-ghost-btn ideas-answered-write" type="button">Write this →</button>'}
      </div>`;
    const writeBtn = row.querySelector('.ideas-answered-write');
    if (writeBtn) {
      writeBtn.addEventListener('click', () => {
        const params = new URLSearchParams({
          type: ['reach', 'trust', 'convert'].includes(item.post_type) ? item.post_type : 'reach',
          idea: item.answer || item.hook || item.question,
        });
        window.location.href = `/generate.html?${params.toString()}`;
      });
    }
    list.appendChild(row);
  });
  section.hidden = false;
}

/* ── "Ask me a question" — mint an on-demand question card ───── */
function bindNewQuestion() {
  const btn = document.getElementById('ideas-new-question');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Thinking…';
    try {
      const res = await fetch('/api/ideas/question', { method: 'POST', headers: apiHeaders() });
      const data = await res.json();
      if (!data.ok || !data.card) throw new Error('question_unavailable');
      const slot = document.getElementById('ideas-question-slot');
      slot.innerHTML = '';
      slot.appendChild(window.ScoutIdeaCards.buildCard(data.card, {
        mode: 'today',
        onRemoved: () => { slot.hidden = true; },
      }));
      slot.hidden = false;
      slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch {
      if (typeof showToast === 'function') showToast('Could not fetch a question — try again.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Ask me a question →';
    }
  });
}

})();

/* dashboard.js — home page data fetching and rendering */

(function () {

/* ── Init ────────────────────────────────────────────────────── */
let _perfTimer1 = null, _perfTimer2 = null;

async function init() {
  const pipelineCard = document.getElementById('pipeline-card');
  if (!pipelineCard) return; // not on dashboard
  const authData = await window.scouthookAuthReady;
  personalizeGreeting(authData);
  loadTodaysIdeas();
  loadStreak();
  loadFunnel();
  loadPipeline();
  loadVoiceProfileBar();
  loadVaultNudge();
  loadPerformance();
  loadLinkedInExpiryBanner();
}

window.__pageInit = init;
window.__pageCleanup = function () {
  clearTimeout(_perfTimer1);
  clearTimeout(_perfTimer2);
  _perfTimer1 = _perfTimer2 = null;
};

init();

function personalizeGreeting(authData) {
  const firstName = (authData?.user?.displayName || '').split(' ')[0];
  if (!firstName) return;
  const heading = document.querySelector('.ti-heading');
  if (heading) heading.textContent = `Today's ideas, ${firstName}`;
}

/* ── Today's Ideas (Idea Engine) ─────────────────────────────── */
async function loadTodaysIdeas() {
  const zone = document.getElementById('todays-ideas');
  if (!zone) return;
  zone.hidden = false;
  try {
    // Shared with the Ideas pill (1h TTL, busted by card actions) — in-flight
    // dedup also stops a same-page double generation on the first load of the day.
    const data = await cachedFetch('/api/ideas/today', { credentials: 'same-origin' }, 60 * 60 * 1000);
    if (!data || !data.ok || !Array.isArray(data.cards) || !data.cards.length) throw new Error('no_cards');
    renderIdeaCards(data.cards);
  } catch {
    // The supply ladder never runs dry, so this is a fetch/auth failure —
    // a one-line inline state replaces the old hero-banner fallback block.
    const wrap = document.getElementById('ti-cards');
    if (wrap) wrap.innerHTML = `<div class="ti-empty">Couldn't load today's ideas — <a href="/generate.html?new=1">write your own →</a></div>`;
  }
}

function renderIdeaCards(cards) {
  const wrap = document.getElementById('ti-cards');
  if (!wrap || !window.ScoutIdeaCards) return;
  wrap.innerHTML = '';
  const onRemoved = () => {
    if (!wrap.querySelector('.ti-card')) {
      wrap.innerHTML = `<div class="ti-empty">That's all for today — fresh ideas tomorrow. <a href="/generate.html?new=1">Or write your own →</a></div>`;
    }
  };
  cards.forEach(card => {
    wrap.appendChild(window.ScoutIdeaCards.buildCard(card, { mode: 'today', onRemoved }));
  });
}

/* ── Consistency streak (Idea Engine Phase 2) ────────────────── */
async function loadStreak() {
  const chip = document.getElementById('ti-streak');
  if (!chip) return;
  try {
    const res = await fetch('/api/ideas/streak', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !data.streak_count) return; // 0 → stay quiet, no pressure
    // A plain "🔥 N-day streak" reads instantly; the old "Consistency / counted
    // today" wording confused new users. Tooltip carries the how-to-keep-it detail.
    const n   = data.streak_count;
    const tip = data.active_today
      ? "You've shown up today — nice."
      : 'Save, answer, or write a post today to keep it going.';
    chip.innerHTML = `<span class="ti-streak-value" title="${tip}">🔥 ${n}-day streak</span>`;
    chip.hidden = false;
  } catch {
    // Non-fatal — the chip is a progressive enhancement
  }
}

/* ── Content funnel — actual vs target mix, last 30 days ─────── */
const FUNNEL_META = {
  reach:   { label: 'Reach',     color: '#047857' },
  trust:   { label: 'Authority', color: '#1D4ED8' },
  convert: { label: 'Convert',   color: '#B45309' },
};

async function loadFunnel() {
  const card = document.getElementById('funnel-card');
  const barsEl = document.getElementById('funnel-bars');
  if (!card || !barsEl) return;
  try {
    const res = await fetch('/api/posts/mix-recommendation', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    // Below the data threshold the card stays hidden — three empty bars
    // would just tell a new user they're behind.
    if (!data.ok || !data.has_enough_data || !data.counts || !data.total) return;

    // One shared x-scale so bars and target ticks are comparable.
    let xMax = 0;
    for (const type of Object.keys(FUNNEL_META)) {
      const share = (data.counts[type] || 0) / data.total;
      xMax = Math.max(xMax, share, data.targets?.[type] || 0);
    }
    if (!xMax) return;

    barsEl.innerHTML = '';
    for (const [type, meta] of Object.entries(FUNNEL_META)) {
      const count = data.counts[type] || 0;
      const share = count / data.total;
      const target = data.targets?.[type] || 0;
      const row = document.createElement('div');
      row.className = 'funnel-row';
      row.innerHTML = `
        <span class="funnel-label">${meta.label}</span>
        <div class="funnel-track">
          <div class="funnel-bar" style="width:${(share / xMax * 100).toFixed(1)}%;background:${meta.color}"></div>
          <div class="funnel-tick" style="left:${(target / xMax * 100).toFixed(1)}%" title="Target ${Math.round(target * 100)}%"></div>
        </div>
        <span class="funnel-value">${count} <span class="funnel-share">· ${Math.round(share * 100)}%</span></span>`;
      barsEl.appendChild(row);
    }

    const insight = document.getElementById('funnel-insight');
    if (insight && data.recommended_type && FUNNEL_META[data.recommended_type]) {
      const label = FUNNEL_META[data.recommended_type].label;
      // Daily 3 always serves at least one card of the recommended type,
      // so the chart can point straight back at the ideas above it.
      insight.textContent = `${label} is under target — today's ideas are weighted toward it.`;
      insight.hidden = false;
    }

    card.hidden = false;
  } catch {
    // Non-fatal — funnel is a progressive enhancement
  }
}

/* ── Voice profile completion ────────────────────────────────── */
async function loadVoiceProfileBar() {
  const section = document.getElementById('voice-profile-bar');
  const fillEl  = document.getElementById('voice-profile-bar-fill');
  const pctEl   = document.getElementById('voice-profile-pct-text');
  const labelEl = document.getElementById('voice-profile-label');
  if (!section || !fillEl || !pctEl || !labelEl) return;
  try {
    const res = await fetch('/api/profile/completion', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || data.pct >= 100) return; // complete — stay quiet, no pressure
    fillEl.style.width = data.pct + '%';
    pctEl.textContent  = `${data.pct}%`;
    // Same tiered copy as the voice wizard's completion bar (settings.js)
    labelEl.textContent = data.pct >= 70
      ? 'Almost there — a couple more stages will sharpen your posts significantly'
      : data.pct >= 30
        ? 'Good progress — keep going to unlock your full voice quality'
        : 'Fill in more stages to improve post quality';
    section.hidden = false;
  } catch {
    // Non-fatal — progressive enhancement
  }
}

/* ── Vault nudge — no source material yet ────────────────────── */
async function loadVaultNudge() {
  const banner = document.getElementById('vault-nudge-banner');
  if (!banner) return;
  try {
    const res = await fetch('/api/vault/documents/count', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || data.count > 0) return; // already has material — stay quiet
    banner.innerHTML = `Your posts get sharper with real material — <a href="/vault.html">upload a case study, doc, or transcript to your Vault →</a>`;
    banner.hidden = false;
  } catch {
    // Non-fatal — progressive enhancement
  }
}

/* ── LinkedIn token expiry banner ────────────────────────────── */
async function loadLinkedInExpiryBanner() {
  const banner = document.getElementById('linkedin-expiry-banner');
  if (!banner) return;

  try {
    const res = await fetch('/api/linkedin/status', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();

    if (!data.connected || data.expires_in_days === null || data.expires_in_days > 7) return;

    const days = data.expires_in_days;
    const label = days <= 0 ? 'has expired' : `expires in ${days} day${days === 1 ? '' : 's'}`;
    banner.innerHTML = `
      <span>Your LinkedIn connection ${escHtml(label)} — scheduled posts will fail until you reconnect.</span>
      <a href="/onboarding.html?step=linkedin">Reconnect now →</a>
    `;
    banner.hidden = false;
  } catch {
    // Non-fatal
  }
}

/* ── Pipeline — next scheduled + recent drafts, one card ─────── */
async function loadPipeline() {
  const list     = document.getElementById('pipeline-list');
  const countsEl = document.getElementById('pipeline-counts');
  if (!list) return;
  try {
    const [statsRes, schedRes, draftsRes] = await Promise.all([
      fetch('/api/stats', { headers: apiHeaders() }),
      fetch('/api/posts/scheduled', { headers: apiHeaders() }),
      fetch('/api/posts?status=draft', { headers: apiHeaders() }),
    ]);
    const stats  = statsRes.ok  ? await statsRes.json()  : {};
    const sched  = schedRes.ok  ? await schedRes.json()  : {};
    const drafts = draftsRes.ok ? await draftsRes.json() : {};

    const draftCount = Number(stats.draft_count || 0);
    const schedCount = Number(stats.scheduled_count || 0);
    if (countsEl) {
      countsEl.textContent =
        `· ${draftCount} draft${draftCount === 1 ? '' : 's'} · ${schedCount} scheduled`;
    }

    const rows = [];
    const nextScheduled = (sched.ok && Array.isArray(sched.posts)) ? sched.posts[0] : null;
    if (nextScheduled) {
      rows.push(buildPipelineRow({
        title: (nextScheduled.content || '').split('\n')[0] || 'Scheduled post',
        meta: `Scheduled · ${formatDate(nextScheduled.scheduled_for, true)}`,
        href: '/drafts.html?tab=scheduled',
        scheduled: true,
      }));
    }
    (drafts.posts || []).slice(0, 3).forEach(p => {
      rows.push(buildPipelineRow({
        title: (p.content || '').split('\n')[0] || 'Draft',
        meta: `Draft · ${formatDate(p.created_at, false)}`,
        href: `/editor/${encodeURIComponent(p.id)}`,
      }));
    });

    if (rows.length) {
      list.innerHTML = '';
      rows.forEach(r => list.appendChild(r));
    }
    // else: keep the static empty state pointing at Today's Ideas
  } catch {
    // Non-fatal — the static empty state stays
  }
}

function buildPipelineRow({ title, meta, href, scheduled }) {
  const row = document.createElement('a');
  row.className = 'pipeline-row';
  row.href = href;
  if (href.startsWith('/editor/')) row.setAttribute('data-no-spa', '');
  row.innerHTML = `
    ${scheduled ? '<svg class="pipeline-row-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' : ''}
    <span class="pipeline-row-title" title="${escHtml(title)}">${escHtml(title)}</span>
    <span class="pipeline-row-meta">${escHtml(meta)}</span>`;
  return row;
}

/* ── Helpers ─────────────────────────────────────────────────── */
function formatDate(isoString, includeTime) {
  try {
    const d = new Date(isoString);
    if (includeTime) {
      const days  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const day   = days[d.getDay()];
      const date  = d.getDate();
      const month = months[d.getMonth()];
      const hours = d.getHours();
      const mins  = String(d.getMinutes()).padStart(2, '0');
      const ampm  = hours >= 12 ? 'pm' : 'am';
      const h     = hours % 12 || 12;
      return `${day} ${date} ${month} · ${h}:${mins}${ampm}`;
    }
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Performance tagging ────────────────────────────────────── */
async function loadPerformance() {
  await Promise.allSettled([
    loadContentIntelligence(),
    loadPerfNudge(),
  ]);
}

/* Content Intelligence — compressed to one line under the Pipeline card
   (the old two-row card didn't earn its chrome) */
async function loadContentIntelligence() {
  const line = document.getElementById('pipeline-insight');
  if (!line) return;
  try {
    const res = await fetch('/api/posts/performance-summary', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !data.enough_data) return;

    const parts = [];
    if (data.archetypes?.length > 0) parts.push(`${data.archetypes[0].archetype_used} hooks`);
    if (data.best_day?.day_name) parts.push(`${data.best_day.day_name.trim()} posts`);
    if (!parts.length) return;

    line.textContent = `${parts.join(' and ')} perform best for you · based on ${data.total_tagged} rated post${data.total_tagged !== 1 ? 's' : ''}`;
    line.hidden = false;
  } catch {
    // Non-fatal
  }
}

/* ── Performance rating modal ────────────────────────────────── */
let _perfPosts       = [];
let _perfIndex       = 0;
let _perfDismissKey  = '';

async function loadPerfNudge() {
  try {
    const authData = await window.scouthookAuthReady;
    const userId   = authData?.user?.user_id || 'anon';
    _perfDismissKey = `sh_perf_dismissed_${userId}`;

    const res = await fetch('/api/posts/untagged-published', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.posts) || data.posts.length === 0) return;

    const now        = Date.now();
    const dismissed  = JSON.parse(localStorage.getItem(_perfDismissKey) || '[]');
    const qualifying = data.posts.filter(p => {
      if (!p.published_at) return false;
      const ageMs = now - new Date(p.published_at).getTime();
      return ageMs >= 24 * 60 * 60 * 1000 && !dismissed.includes(String(p.id));
    });

    if (qualifying.length === 0) return;

    _perfPosts = qualifying;
    _perfIndex = 0;

    // Let the page settle, then auto-show
    _perfTimer1 = setTimeout(openPerfModal, 1500);
  } catch {
    // Non-fatal
  }
}

function openPerfModal() {
  const overlay = document.getElementById('perf-modal-overlay');
  if (!overlay) return;
  _renderPerfModalContent();
  overlay.hidden = false;
}

function closePerfModal() {
  const overlay = document.getElementById('perf-modal-overlay');
  if (overlay) overlay.hidden = true;
}

function _renderPerfModalContent() {
  const post    = _perfPosts[_perfIndex];
  const preview = document.getElementById('perf-modal-preview');
  const countEl = document.getElementById('perf-modal-count');
  if (!post) { closePerfModal(); return; }

  if (preview) preview.textContent = post.content || '';

  if (countEl) {
    countEl.textContent = _perfPosts.length > 1
      ? `${_perfIndex + 1} of ${_perfPosts.length}`
      : '';
  }

  // Bind buttons each time content changes
  document.querySelectorAll('.perf-modal-btn').forEach(btn => {
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
  });
  document.querySelectorAll('.perf-modal-btn').forEach(btn => {
    btn.addEventListener('click', () => _submitPerfRating(btn.dataset.tag));
  });

  const skip = document.getElementById('perf-modal-skip');
  if (skip) {
    const freshSkip = skip.cloneNode(true);
    skip.replaceWith(freshSkip);
    freshSkip.addEventListener('click', () => _advancePerfModal(true));
  }
}

async function _submitPerfRating(tag) {
  const post = _perfPosts[_perfIndex];
  if (!post) return;

  const modal = document.getElementById('perf-modal');
  if (!modal) return;

  try {
    const r = await fetch(`/api/posts/${encodeURIComponent(post.id)}/performance`, {
      method:  'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tag }),
    });
    if (r.ok) _showPerfSuccess(tag, modal);
    else _advancePerfModal(false);
  } catch {
    _advancePerfModal(false);
  }
}

function _showPerfSuccess(tag, modal) {
  const meta = {
    strong: { emoji: '🔥', title: "That's the data we needed!", sub: 'ScoutHook is learning what makes your audience light up.' },
    decent: { emoji: '👍', title: 'Good to know!',              sub: 'Every data point helps us sharpen your future posts.' },
    weak:   { emoji: '👎', title: 'Thanks for being honest!',   sub: 'Knowing what didn\'t land is just as valuable as knowing what did.' },
  };
  const m = meta[tag] || meta.decent;

  modal.innerHTML = `
    <div class="perf-modal-success">
      <span class="perf-modal-success-emoji">${m.emoji}</span>
      <h2 class="perf-modal-success-title">${m.title}</h2>
      <p class="perf-modal-success-sub">${m.sub}</p>
    </div>`;

  _perfTimer2 = setTimeout(() => _advancePerfModal(false), 1800);
}

function _advancePerfModal(wasDismissed) {
  if (wasDismissed) {
    const post      = _perfPosts[_perfIndex];
    const dismissed = JSON.parse(localStorage.getItem(_perfDismissKey) || '[]');
    if (post && !dismissed.includes(String(post.id))) {
      dismissed.push(String(post.id));
      localStorage.setItem(_perfDismissKey, JSON.stringify(dismissed));
    }
  }

  _perfIndex++;
  if (_perfIndex >= _perfPosts.length) {
    closePerfModal();
    return;
  }

  // Restore modal shell for next post
  const modal = document.getElementById('perf-modal');
  if (modal) {
    modal.innerHTML = _perfModalShellHTML();
    _renderPerfModalContent();
  }
}

function _perfModalShellHTML() {
  return `
      <div class="perf-modal-header">
        <div class="perf-modal-clock">⏰</div>
        <h2 class="perf-modal-title" id="perf-modal-title">24 hours later… how did it go?</h2>
        <p class="perf-modal-subtitle">Your post has been live for a day. Rate it below — it takes 3 seconds and makes every future post smarter.</p>
      </div>
      <div class="perf-modal-preview-wrap">
        <div class="perf-modal-preview-label">Your post</div>
        <div class="perf-modal-preview" id="perf-modal-preview"></div>
      </div>
      <div class="perf-modal-why">
        <span class="perf-modal-why-icon">💡</span>
        <div class="perf-modal-why-body">
          <span class="perf-modal-why-label">Why we ask</span>
          <span class="perf-modal-why-text">Your rating trains ScoutHook's Content Intelligence engine. After just 3 ratings, you'll unlock insights on which hook styles and posting days drive the most engagement for <em>your</em> audience — not some generic average.</span>
        </div>
      </div>
      <p class="perf-modal-rating-label">How did this post perform?</p>
      <div class="perf-modal-btns">
        <button class="perf-modal-btn" data-tag="strong">
          <span class="perf-modal-btn-emoji">🔥</span>
          <span class="perf-modal-btn-label">Strong</span>
          <span class="perf-modal-btn-desc">Got leads, DMs, or real engagement</span>
        </button>
        <button class="perf-modal-btn" data-tag="decent">
          <span class="perf-modal-btn-emoji">👍</span>
          <span class="perf-modal-btn-label">Decent</span>
          <span class="perf-modal-btn-desc">Some engagement, nothing remarkable</span>
        </button>
        <button class="perf-modal-btn" data-tag="weak">
          <span class="perf-modal-btn-emoji">👎</span>
          <span class="perf-modal-btn-label">Weak</span>
          <span class="perf-modal-btn-desc">Little to no engagement</span>
        </button>
      </div>
      <div class="perf-modal-footer">
        <button class="perf-modal-skip" id="perf-modal-skip">Skip for now</button>
        <span class="perf-modal-count" id="perf-modal-count"></span>
      </div>`;
}

})();

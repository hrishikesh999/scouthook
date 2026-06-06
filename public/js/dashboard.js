/* dashboard.js — home page data fetching and rendering */

/* ── Init ────────────────────────────────────────────────────── */
let _perfTimer1 = null, _perfTimer2 = null;

async function init() {
  const recentList = document.getElementById('recent-posts-list');
  if (!recentList) return; // not on dashboard
  await window.scouthookAuthReady;
  loadRecentPosts();
  loadChecklist();
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

/* ── Recent posts ────────────────────────────────────────────── */
async function loadRecentPosts() {
  const recentList = document.getElementById('recent-posts-list');
  try {
    const res  = await fetch('/api/posts/recent', { headers: apiHeaders() });
    if (!res.ok) throw new Error('No recent posts endpoint');
    const data = await res.json();

    const posts = data.posts || data;
    if (!Array.isArray(posts) || posts.length === 0) {
      showEmptyRecent();
      return;
    }

    renderPostRows(recentList, posts.slice(0, 5), 'recent');
  } catch {
    showEmptyRecent();
  }
}

function showEmptyRecent() {
  const recentList = document.getElementById('recent-posts-list');
  if (recentList) recentList.innerHTML = `
    <div class="card-empty-state">
      No posts yet — <a href="/generate.html?new=1">Generate your first post →</a>
    </div>`;
}

/* ── Onboarding checklist ────────────────────────────────────── */
async function loadChecklist() {
  // Scope the dismiss flag to the signed-in user — prevents a prior account's
  // completed flag from hiding the checklist for a new account on the same browser.
  const authData = await window.scouthookAuthReady;
  const userId   = authData?.user?.user_id || 'anon';
  const doneKey  = `sh_checklist_done_${userId}`;

  if (localStorage.getItem(doneKey)) return;

  const section  = document.getElementById('onboarding-checklist');
  const barEl    = document.getElementById('checklist-bar');
  const textEl   = document.getElementById('checklist-progress-text');
  const itemsEl  = document.getElementById('checklist-items');
  if (!section || !barEl || !textEl || !itemsEl) return;

  try {
    const res  = await fetch('/api/checklist', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;

    // If all done on this load, collapse immediately and remember
    if (data.all_done) {
      collapseChecklist(section, doneKey);
      return;
    }

    // Personalise the hero banner
    const firstName = (data.display_name || '').split(' ')[0];
    if (firstName) {
      const heading    = document.querySelector('.hero-heading');
      const subheading = document.querySelector('.hero-subheading');
      if (heading)    heading.textContent    = `Welcome, ${firstName}. Your LinkedIn posting engine is ready.`;
      if (subheading) subheading.textContent = 'Your voice profile is set up. Start by publishing your first post.';
    }

    // Progress bar and counter
    const pct = Math.round((data.completed_count / data.total) * 100);
    barEl.style.width  = pct + '%';
    textEl.textContent = `${data.completed_count} of ${data.total} complete`;

    // Render items
    itemsEl.innerHTML = '';
    data.steps.forEach(step => {
      const li = document.createElement('li');
      li.className = 'checklist-item' + (step.done ? ' done' : '');

      if (step.done) {
        const tickSvg = `<svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true"><path d="M1 4.5L4 7.5L10 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        li.innerHTML = `
          <span class="checklist-tick" aria-hidden="true">${tickSvg}</span>
          <span class="checklist-label">${escHtml(step.label)}</span>
        `;
      } else {
        li.innerHTML = `
          <a class="checklist-row" href="${escHtml(step.href)}">
            <span class="checklist-tick" aria-hidden="true"></span>
            <span class="checklist-label">${escHtml(step.label)}</span>
            <span class="checklist-arrow" aria-hidden="true">→</span>
          </a>
        `;
      }
      itemsEl.appendChild(li);
    });

    // Show the section
    section.hidden = false;

  } catch {
    // Non-fatal — checklist is a progressive enhancement
  }
}

function collapseChecklist(section, doneKey) {
  section.classList.add('collapsing');
  section.addEventListener('transitionend', () => {
    section.hidden = true;
    section.classList.remove('collapsing');
  }, { once: true });
  localStorage.setItem(doneKey, '1');
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

/* ── Render rows ─────────────────────────────────────────────── */
function renderPostRows(container, posts, type) {
  container.innerHTML = '';
  posts.forEach((post, index) => {
    const row = document.createElement('div');
    row.className = 'post-row';

    // Determine content text
    const text = post.content || post.post || '';
    const firstLine = text.split('\n')[0] || text;

    // Date string
    let dateStr = '';
    const dateField = type === 'scheduled' ? post.scheduled_for : (post.created_at || post.date);
    if (dateField) {
      dateStr = formatDate(dateField, type === 'scheduled');
    }

    // Score
    const score = post.quality_score !== undefined && post.quality_score !== null
      ? Math.round(post.quality_score)
      : null;
    const badgeClass = score !== null ? scoreClass(score) : 'none';
    const badgeText  = score !== null ? String(score) : '—';

    // Status
    const status     = post.status || (type === 'scheduled' ? 'scheduled' : 'draft');
    const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);

    row.innerHTML = `
      <div class="post-row-left">
        <div class="post-row-title" title="${escHtml(firstLine)}">${escHtml(firstLine)}</div>
        <div class="post-row-date">${escHtml(dateStr)}</div>
      </div>
      <div class="post-row-right">
        <span class="score-badge ${badgeClass}" aria-label="Quality score: ${badgeText}">${badgeText}</span>
        <span class="status-pill ${status.toLowerCase()}">${escHtml(statusLabel)}</span>
      </div>`;

    container.appendChild(row);
  });
}

/* ── Helpers ─────────────────────────────────────────────────── */
function scoreClass(score) {
  if (score >= 75) return 'pass';
  if (score >= 50) return 'borderline';
  return 'fail';
}

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

async function loadContentIntelligence() {
  try {
    const res = await fetch('/api/posts/performance-summary', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !data.enough_data) return;
    renderContentIntelligence(data);
  } catch {
    // Non-fatal
  }
}

function renderContentIntelligence(data) {
  const card    = document.getElementById('content-intelligence');
  const body    = document.getElementById('ci-body');
  const countEl = document.getElementById('ci-tag-count');
  if (!card || !body) return;

  countEl.textContent = `Based on ${data.total_tagged} rated post${data.total_tagged !== 1 ? 's' : ''}`;

  const rows = [];

  if (data.archetypes?.length > 0) {
    const top  = data.archetypes[0];
    const rate = top.total > 0 ? Math.round((top.strong_count / top.total) * 100) : 0;
    rows.push(`<div class="ci-insight">
      <span class="ci-label">Best hook type</span>
      <span class="ci-value">${escHtml(top.archetype_used)} — ${rate}% strong posts</span>
    </div>`);
  }

  if (data.best_day) {
    const day = (data.best_day.day_name || '').trim();
    rows.push(`<div class="ci-insight">
      <span class="ci-label">Best day to post</span>
      <span class="ci-value">${escHtml(day)} — highest strong rate</span>
    </div>`);
  }

  if (rows.length === 0) return;
  body.innerHTML = rows.join('');
  card.hidden = false;
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



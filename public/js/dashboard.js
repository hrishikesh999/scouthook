/* dashboard.js — home page data fetching and rendering */

/* ── DOM References ──────────────────────────────────────────── */
const recentList = document.getElementById('recent-posts-list');

/* ── Init ────────────────────────────────────────────────────── */
(async function init() {
  await window.scouthookAuthReady;
  loadRecentPosts();
  loadChecklist();
  loadPerformance();
  loadLinkedInExpiryBanner();
  loadVoiceProfileCard();
})();

/* ── Recent posts ────────────────────────────────────────────── */
async function loadRecentPosts() {
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
  recentList.innerHTML = `
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

      const tickSvg = step.done
        ? `<svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true"><path d="M1 4.5L4 7.5L10 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
        : '';

      li.innerHTML = `
        <span class="checklist-tick" aria-hidden="true">${tickSvg}</span>
        <span class="checklist-label">${escHtml(step.label)}</span>
        ${!step.done ? `<a class="checklist-link" href="${escHtml(step.href)}">Go →</a>` : ''}
      `;
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
  // Run both fetches in parallel — they are independent
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

async function loadPerfNudge() {
  try {
    const res = await fetch('/api/posts/untagged-published', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;
    if (Array.isArray(data.posts) && data.posts.length > 0) {
      renderPerfNudge(data.posts);
    }
  } catch {
    // Non-fatal
  }
}

function renderContentIntelligence(data) {
  const card   = document.getElementById('content-intelligence');
  const body   = document.getElementById('ci-body');
  const countEl = document.getElementById('ci-tag-count');
  if (!card || !body) return;

  countEl.textContent = `Based on ${data.total_tagged} rated post${data.total_tagged !== 1 ? 's' : ''}`;

  const rows = [];

  if (data.archetypes?.length > 0) {
    const top = data.archetypes[0];
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

function renderPerfNudge(posts) {
  const card = document.getElementById('perf-nudge');
  const list = document.getElementById('perf-nudge-list');
  if (!card || !list) return;

  list.innerHTML = posts.map(post => {
    const firstLine = (post.content || '').split('\n').find(l => l.trim()) || '';
    const dateStr   = post.published_at
      ? new Date(post.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      : '';
    return `<div class="perf-nudge-row" data-post-id="${post.id}">
      <div class="perf-nudge-text">
        <span class="perf-nudge-hook">${escHtml(firstLine)}</span>
        <span class="perf-nudge-date">${escHtml(dateStr)}</span>
      </div>
      <div class="perf-nudge-btns" aria-label="Rate this post">
        <button class="perf-btn" data-tag="strong" title="Strong — got leads, DMs or strong engagement">🔥</button>
        <button class="perf-btn" data-tag="decent" title="Decent — some engagement, nothing remarkable">👍</button>
        <button class="perf-btn" data-tag="weak"   title="Weak — little engagement">👎</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.perf-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row    = btn.closest('.perf-nudge-row');
      const postId = row?.dataset.postId;
      const tag    = btn.dataset.tag;
      if (!postId || !tag) return;

      try {
        const r = await fetch(`/api/posts/${encodeURIComponent(postId)}/performance`, {
          method:  'POST',
          headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
          body:    JSON.stringify({ tag }),
        });
        if (r.ok) {
          row.innerHTML = `<div class="perf-nudge-done">Rated as <strong>${tag}</strong> — thanks!</div>`;
          const remaining = list.querySelectorAll('.perf-nudge-row').length;
          if (remaining === 0) card.hidden = true;
        }
      } catch {
        // Non-fatal
      }
    });
  });

  card.hidden = false;
}

/* ── Voice Profile Card ──────────────────────────────────────── */
// Shown until voice_profile_completion_pct >= 80.
// Shows the next highest-value action with a link to the wizard.
async function loadVoiceProfileCard() {
  const card = document.getElementById('voice-profile-card');
  if (!card) return;

  try {
    const uid = getUserId();
    const res = await fetch('/api/profile/' + encodeURIComponent(uid), { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const profile = data.profile;
    if (!profile) return;

    const pct = profile.voice_profile_completion_pct || 0;

    // Hide once >= 80%
    if (pct >= 80) return;

    // Update bar + percentage
    const fill  = document.getElementById('vp-bar-fill');
    const pctEl = document.getElementById('vp-bar-pct');
    if (fill)  fill.style.width  = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';

    // Determine next highest-value action and link
    const nextEl = document.getElementById('vp-card-next');
    const ctaEl  = document.getElementById('vp-card-cta');

    function safeParseJSON(val, fallback) {
      try { return val ? JSON.parse(val) : fallback; } catch { return fallback; }
    }

    let nextText = 'Complete your voice profile.';
    let ctaHref  = '/settings.html';

    const samples     = profile.writing_samples?.trim() || '';
    const statements  = safeParseJSON(profile.authority_statements, []);
    const ctas        = safeParseJSON(profile.cta_library, []);
    const themes      = safeParseJSON(profile.content_themes, []);

    if (!profile.business_positioning && !profile.content_niche) {
      nextText = 'Fill in your profile basics to personalise every post. +15%';
      ctaHref  = '/settings.html#voice-stage-1';
    } else if (!profile.onboarding_q1 || !profile.onboarding_q2 || !profile.onboarding_q3) {
      nextText = 'Complete onboarding to capture your baseline voice. +15%';
      ctaHref  = '/onboarding.html';
    } else if (themes.length === 0) {
      nextText = 'Confirm your content themes — AI will suggest them. +5%';
      ctaHref  = '/settings.html#voice-stage-2';
    } else if (statements.length < 3) {
      nextText = 'Add credibility statements so posts include real proof points. +10%';
      ctaHref  = '/settings.html#voice-stage-3';
    } else if (ctas.length < 2) {
      nextText = 'Add 2+ CTAs so posts close with your actual words. +10%';
      ctaHref  = '/settings.html#voice-stage-4';
    } else if (!samples) {
      nextText = 'Add writing samples for the sharpest voice match. +20%';
      ctaHref  = '/settings.html#voice-stage-7';
    } else {
      nextText = 'Connect LinkedIn to unlock the deepest voice match. +20%';
      ctaHref  = '/settings.html#voice-stage-6';
    }

    if (nextEl) nextEl.textContent = nextText;
    if (ctaEl)  ctaEl.href = ctaHref;

    card.hidden = false;
  } catch {
    // Non-fatal — voice profile card is progressive enhancement
  }
}


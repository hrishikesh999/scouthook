/* dashboard.js — home page data fetching and rendering */

/* ── Helpers ─────────────────────────────────────────────────── */
function buildLinkedInChip(name, photoUrl) {
  const initials = name
    ? name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
    : '??';
  const avatarHtml = photoUrl
    ? `<img class="nav-linkedin-avatar" src="${photoUrl}" alt="${name || 'LinkedIn'}">`
    : `<div class="nav-linkedin-initials">${initials}</div>`;
  const nameHtml = name ? `<span class="nav-linkedin-name">${name}</span>` : '';
  return `
    <div class="nav-linkedin-connected" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
      <div style="display:flex;align-items:center;gap:8px;min-width:0;">
        ${avatarHtml}
        ${nameHtml}
      </div>
      <button
        type="button"
        class="nav-linkedin-disconnect"
        style="border:0;background:transparent;color:var(--text-muted);font-size:12px;padding:6px 6px;cursor:pointer;"
        aria-label="Disconnect LinkedIn"
        title="Disconnect"
      >Disconnect</button>
    </div>`;
}

async function disconnectLinkedIn() {
  try {
    await fetch('/api/linkedin/disconnect', { method: 'POST', headers: apiHeaders() });
  } catch { /* ignore */ }
  try { Session?.clear?.(); } catch { /* ignore */ }
  window.location.href = '/login.html';
}

/* ── DOM References ──────────────────────────────────────────── */
const statPostsMonth   = document.getElementById('stat-posts-month');
const statAvgScore     = document.getElementById('stat-avg-score');
const statLinkedIn     = document.getElementById('stat-linkedin-value');
const statLinkedInSub  = document.getElementById('stat-linkedin-sublabel');
const recentList       = document.getElementById('recent-posts-list');

/* ── Init ────────────────────────────────────────────────────── */
(async function init() {
  // Wire userId into the Connect LinkedIn button href so the OAuth redirect carries it
  const connectBtn = document.getElementById('linkedin-connect-btn');
  if (connectBtn) {
    connectBtn.href = `/api/linkedin/connect?_uid=${encodeURIComponent(getUserId())}&_tid=${encodeURIComponent(getTenantId())}`;
  }

  await checkLinkedInStatus();
  loadStats();
  loadRecentPosts();
})();

/* ── LinkedIn status ─────────────────────────────────────────── */
async function checkLinkedInStatus() {
  try {
    const res  = await fetch('/api/linkedin/status', { headers: apiHeaders() });
    const data = await res.json();
    const area = document.getElementById('nav-linkedin-area');

    if (data.connected) {
      // Update nav
      area.innerHTML = buildLinkedInChip(data.name, data.photo_url);
      area.querySelector('.nav-linkedin-disconnect')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        disconnectLinkedIn();
      });

      // Update stat card
      statLinkedIn.textContent = 'Connected';
      statLinkedIn.className   = 'stat-value-text connected';
      if (data.name) {
        statLinkedInSub.textContent = data.name;
      } else {
        statLinkedInSub.textContent = '';
      }
    } else {
      // Update the "Connect your account" link in the stat card with the uid
      const connectUrl = `/api/linkedin/connect?_uid=${encodeURIComponent(getUserId())}&_tid=${encodeURIComponent(getTenantId())}`;
      statLinkedInSub.innerHTML = `<a href="${connectUrl}" style="color:var(--teal);text-decoration:none;">Connect your account</a>`;
    }
    // Return connection state so loadStats can use the scheduled count from LinkedIn
    return data.connected;
  } catch {
    return false;
  }
}

/* ── Stats ───────────────────────────────────────────────────── */
async function loadStats() {
  try {
    const res  = await fetch('/api/stats', { headers: apiHeaders() });
    if (!res.ok) throw new Error('No stats endpoint');
    const data = await res.json();

    if (data.posts_this_month !== undefined) {
      statPostsMonth.textContent = data.posts_this_month;
    }

    if (data.avg_quality_score !== undefined && data.avg_quality_score !== null) {
      const score = Math.round(data.avg_quality_score);
      statAvgScore.textContent = score;
      statAvgScore.className   = 'stat-value ' + scoreClass(score);
    }

  } catch {
    // Graceful — leave '—' placeholders
  }
}


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
      No posts yet — <a href="/generate.html?new=1">Generate →</a>
    </div>`;
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

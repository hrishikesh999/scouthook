/* schedule.js — Editorial Agenda for schedule.html */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTitleCase(str) {
  if (!str) return '';
  return str.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function localDateKey(isoString) {
  // Returns "YYYY-MM-DD" in the user's local timezone
  const d = new Date(isoString);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Calendar key for a local Date (do not use date.toISOString() — UTC shifts the day). */
function localDateKeyFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDayHeading(date) {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function todayMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// ---------------------------------------------------------------------------
// Build a 7-day date range starting from today
// ---------------------------------------------------------------------------

function buildDayRange() {
  const days = [];
  const base = todayMidnight();
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    days.push(d);
  }
  return days;
}

// ---------------------------------------------------------------------------
// Group posts by local date key, sorted by scheduled_for within each group
// ---------------------------------------------------------------------------

function groupByDate(posts) {
  const map = new Map();
  for (const post of posts) {
    const key = localDateKey(post.scheduled_for);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(post);
  }
  // Sort each day's posts by scheduled_for ascending
  for (const [, dayPosts] of map) {
    dayPosts.sort((a, b) => new Date(a.scheduled_for) - new Date(b.scheduled_for));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderStream(posts) {
  const stream = document.getElementById('schedule-stream');
  if (!stream) return;
  const list   = Array.isArray(posts) ? posts : [];
  const days   = buildDayRange();
  const byDate = groupByDate(list);

  stream.innerHTML = days.map(date => {
    const key      = localDateKeyFromDate(date);
    const dayPosts = byDate.get(key) || [];
    return renderDayGroup(date, dayPosts);
  }).join('');
}

function renderDayGroup(date, posts) {
  const heading = formatDayHeading(date);
  const subtitle = posts.length === 0
    ? 'No posts scheduled'
    : posts.length === 1 ? '1 post' : `${posts.length} posts`;

  const bodyHtml = posts.length > 0
    ? `<div class="sched-day-body"><div class="sched-thread">${posts.map(renderPostRow).join('')}</div></div>`
    : '';

  return `
    <div class="sched-day-group">
      <div class="sched-day-card">
        <div class="sched-day-header">
          <h2 class="sched-day-heading">${heading}</h2>
          <p class="sched-day-subtitle">${subtitle}</p>
        </div>
        ${bodyHtml}
      </div>
    </div>`;
}

function renderPostRow(post) {
  const time      = formatTime(post.scheduled_for);
  const archetype = toTitleCase(post.format_slug);
  const words     = (post.content || '').trim().split(/\s+/);
  const preview   = words.slice(0, 30).join(' ') + (words.length > 30 ? '…' : '');

  const badgeHtml = archetype
    ? `<span class="sched-archetype-badge">${archetype}</span>`
    : '';

  const editHref = post.post_id
    ? `/generate.html?postId=${encodeURIComponent(post.post_id)}`
    : null;
  const editHtml = editHref
    ? `<a href="${editHref}" class="sched-action-edit" title="Opens compose — use Pause to edit while still scheduled">Edit</a>`
    : '';

  const actionsHtml = editHtml
    ? `<div class="sched-post-actions">${editHtml}</div>`
    : '';

  return `
    <div class="sched-post-card" data-id="${post.id}">
      <span class="sched-dot" aria-hidden="true"></span>
      <div class="sched-post-inner">
        <div class="sched-post-meta">
          <span class="sched-post-time">${time}</span>
          ${badgeHtml}
        </div>
        <p class="sched-post-content text-post">${preview}</p>
        ${actionsHtml}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// LinkedIn status (topbar)
// ---------------------------------------------------------------------------

async function checkLinkedInStatus() {
  const connectBtn = document.getElementById('linkedin-connect-btn');
  if (connectBtn) {
    connectBtn.href = `/api/linkedin/connect?_uid=${encodeURIComponent(getUserId())}&_tid=${encodeURIComponent(getTenantId())}`;
  }
  try {
    const res  = await fetch('/api/linkedin/status', { headers: apiHeaders() });
    const data = await res.json();
    const btn  = document.getElementById('linkedin-connect-btn');
    if (!btn) return;
    if (data.connected) {
      btn.textContent = `✓ ${data.name || 'LinkedIn Connected'}`;
      btn.style.color = 'var(--accent)';
      btn.style.pointerEvents = 'none';
    }
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  checkLinkedInStatus();

  try {
    const res  = await fetch('/api/linkedin/scheduled', { headers: apiHeaders() });
    const data = await res.json();
    renderStream(data.ok && Array.isArray(data.posts) ? data.posts : []);
  } catch {
    renderStream([]);
  }
});

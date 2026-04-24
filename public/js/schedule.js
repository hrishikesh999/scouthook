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

function formatDayParts(date) {
  const today    = todayMidnight();
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const isToday    = date.getTime() === today.getTime();
  const isTomorrow = date.getTime() === tomorrow.getTime();

  const weekday = date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  const num     = date.getDate();
  const month   = date.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
  const label   = isToday ? 'TODAY' : isTomorrow ? 'TOMORROW' : null;

  return { weekday, num, month, label };
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
  const failed = list.filter(p => p.status === 'not_sent');
  const active = list.filter(p => p.status !== 'not_sent');

  const days   = buildDayRange();
  const byDate = groupByDate(active);

  // Day keys covered by the 7-day window
  const windowKeys = new Set(days.map(localDateKeyFromDate));

  // "Next 7 days" section — always show all 7 days
  const weekHtml = days.map(date => {
    const key = localDateKeyFromDate(date);
    return renderDayGroup(date, byDate.get(key) || []);
  }).join('');

  // "Coming up" section — scheduled posts beyond the 7-day window
  const laterEntries = [...byDate.entries()]
    .filter(([key]) => !windowKeys.has(key))
    .sort(([a], [b]) => a.localeCompare(b));

  let laterHtml = '';
  if (laterEntries.length > 0) {
    const groups = laterEntries.map(([key, dayPosts]) => {
      const [y, m, d] = key.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      return renderDayGroup(date, dayPosts);
    }).join('');
    laterHtml = `
      <div class="sched-section-divider">
        <span class="sched-section-label">Coming up</span>
      </div>
      ${groups}`;
  }

  // "Failed to Publish" section
  let failedHtml = '';
  if (failed.length > 0) {
    const rows = failed.map(renderFailedRow).join('');
    failedHtml = `
      <div class="sched-section-divider sched-section-divider--failed">
        <span class="sched-section-label sched-section-label--failed">Failed to Publish</span>
      </div>
      <div class="sched-failed-list">${rows}</div>`;
  }

  stream.innerHTML = weekHtml + laterHtml + failedHtml;
}

function renderDayGroup(date, posts) {
  const { weekday, num, month, label } = formatDayParts(date);
  const isToday    = label === 'TODAY';
  const weekdayFull = date.toLocaleDateString('en-US', { weekday: 'long' });
  const monthFull   = date.toLocaleDateString('en-US', { month: 'long' });
  const countLabel  = posts.length === 1 ? '1 post' : posts.length > 1 ? `${posts.length} posts` : '';

  const bodyHtml = posts.length > 0
    ? `<div class="sched-events">${posts.map(renderEventRow).join('')}</div>`
    : '';

  const contentHtml = posts.length > 0
    ? `<div class="sched-events">${posts.map(renderEventRow).join('')}</div>`
    : `<p class="sched-empty-hint">No posts scheduled</p>`;

  return `
    <div class="sched-day-group${isToday ? ' sched-day-group--today' : ''}${posts.length === 0 ? ' sched-day-group--empty' : ''}">
      <div class="sched-day-aside">
        <span class="sched-dp-wday">${label || weekday}</span>
        <span class="sched-dp-num">${num}</span>
        <span class="sched-dp-month">${month}</span>
      </div>
      <div class="sched-day-content">
        ${contentHtml}
      </div>
    </div>`;
}

function renderEventRow(post) {
  const time      = formatTime(post.scheduled_for);
  const archetype = toTitleCase(post.format_slug);
  const lines     = (post.content || '').trim().split('\n').map(l => l.trim()).filter(Boolean);
  const hook      = lines[0] || '';
  const second    = lines[1] || '';

  const editHref = post.post_id
    ? `/generate.html?postId=${encodeURIComponent(post.post_id)}`
    : null;

  const tag    = editHref ? `a href="${editHref}"` : 'div';
  const endTag = editHref ? 'a' : 'div';

  return `
    <${tag} class="sched-event" data-id="${post.id}">
      <div class="sched-evt-time-badge">${time}</div>
      <div class="sched-evt-body">
        <div class="sched-evt-badges">
          ${archetype ? `<span class="sched-archetype-badge">${archetype}</span>` : ''}
          ${post.funnel_type ? `<span class="funnel-badge ${post.funnel_type}">${post.funnel_type}</span>` : ''}
        </div>
        <p class="sched-evt-hook">${hook}</p>
        ${second ? `<p class="sched-evt-second">${second}</p>` : ''}
        <span class="sched-action-edit">Edit →</span>
      </div>
    </${endTag}>`;
}

function renderFailedRow(post) {
  const lines    = (post.content || '').trim().split('\n').map(l => l.trim()).filter(Boolean);
  const hook     = lines[0] || '';
  const editHref = post.post_id ? `/generate.html?postId=${encodeURIComponent(post.post_id)}` : '/generate.html';
  const when     = post.scheduled_for
    ? new Date(post.scheduled_for).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : '';

  const errorMap = {
    reconnect_required: 'LinkedIn connection expired',
    not_connected: 'LinkedIn not connected',
    rate_limit_exceeded: 'Rate limit exceeded',
    invalid_image_url: 'Image could not be accessed',
    invalid_carousel_pdf_url: 'Carousel PDF could not be accessed',
    linkedin_document_processing_failed: 'LinkedIn rejected the carousel',
    linkedin_document_not_ready: 'LinkedIn timed out on carousel',
    stuck_processing_timeout: 'Worker timed out',
    scheduled_payload_mismatch: 'Post content was modified after scheduling',
  };
  const reason = errorMap[post.error_message] || post.error_message || 'Unknown error';

  return `
    <a href="${editHref}" class="sched-failed-row">
      <div class="sched-failed-meta">
        <span class="sched-failed-badge">Failed to Publish</span>
        ${when ? `<span class="sched-failed-when">Scheduled for ${when}</span>` : ''}
      </div>
      <p class="sched-failed-hook">${hook}</p>
      <p class="sched-failed-reason">${reason}</p>
      <span class="sched-action-edit">Edit &amp; reschedule →</span>
    </a>`;
}

// ---------------------------------------------------------------------------
// LinkedIn status (sidebar)
// ---------------------------------------------------------------------------

function buildLinkedInChip(name, photoUrl) {
  const initials = name
    ? name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
    : '??';
  const avatarHtml = photoUrl
    ? `<img class="nav-linkedin-avatar" src="${photoUrl}" alt="${name || 'LinkedIn'}">`
    : `<div class="nav-linkedin-initials">${initials}</div>`;
  const nameHtml = name ? `<span class="nav-linkedin-name">${name}</span>` : '';
  return `<div class="nav-linkedin-connected">${avatarHtml}${nameHtml}</div>`;
}

async function checkLinkedInStatus() {
  const connectBtn = document.getElementById('linkedin-connect-btn');
  if (connectBtn) {
    connectBtn.href = `/api/linkedin/connect?_uid=${encodeURIComponent(getUserId())}&_tid=${encodeURIComponent(getTenantId())}`;
  }
  try {
    const res  = await fetch('/api/linkedin/status', { headers: apiHeaders() });
    const data = await res.json();
    const area = document.getElementById('nav-linkedin-area');
    if (!area) return;
    if (data.connected) {
      area.innerHTML = buildLinkedInChip(data.name, data.photo_url);
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

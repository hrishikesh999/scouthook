/* published.js — Published page logic for Scouthook */

// Client-side rate guard: track last successful sync timestamp per postId.
// Prevents hammering the button faster than the server cooldown allows.
const syncTimestamps = new Map();
const CLIENT_COOLDOWN_MS = 60 * 1000; // 60 seconds

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTitleCase(str) {
  if (!str) return '';
  return str.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatDate(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function metricDisplay(value) {
  return (value == null || value === 0) ? '—' : String(value);
}

function timeAgo(isoString) {
  if (!isoString) return null;
  const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 5)   return 'Just now';
  if (diff < 60)  return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function showToast(message, isError = false) {
  const toast = document.getElementById('published-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = 'published-toast published-toast--visible' + (isError ? ' published-toast--error' : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.className = 'published-toast';
  }, 5000);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderEmpty() {
  const list = document.getElementById('published-list');
  list.innerHTML = `
    <div class="published-empty">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452z"/>
      </svg>
      <p class="published-empty-title">Nothing published yet</p>
      <p class="published-empty-msg">Your LinkedIn posts will appear here once published.</p>
      <a href="/generate.html?new=1" class="published-empty-cta">Write your first post →</a>
    </div>`;
}

function renderStats(posts) {
  const strip = document.getElementById('published-stats');
  if (!strip) return;
  const total     = posts.length;
  const totalLikes     = posts.reduce((s, p) => s + (p.likes     || 0), 0);
  const totalComments  = posts.reduce((s, p) => s + (p.comments  || 0), 0);
  const totalReactions = posts.reduce((s, p) => s + (p.reactions || 0), 0);

  strip.innerHTML = `
    <div class="pub-stat-card">
      <span class="pub-stat-value">${total}</span>
      <span class="pub-stat-label">Posts published</span>
    </div>
    <div class="pub-stat-card">
      <span class="pub-stat-value">${totalLikes || '—'}</span>
      <span class="pub-stat-label">Total likes</span>
    </div>
    <div class="pub-stat-card">
      <span class="pub-stat-value">${totalComments || '—'}</span>
      <span class="pub-stat-label">Comments</span>
    </div>
    <div class="pub-stat-card">
      <span class="pub-stat-value">${totalReactions || '—'}</span>
      <span class="pub-stat-label">Reactions</span>
    </div>`;
}

function renderList(posts) {
  const list = document.getElementById('published-list');

  const cards = posts.map(post => {
    const dateStr     = formatDate(post.published_at);
    const archetype   = toTitleCase(post.format_slug);
    const hook        = escHtml(((post.content || '').trim().split('\n')[0] || '').trim());
    const assetLabel  = post.asset_type === 'carousel' ? 'Carousel' : post.asset_type === 'image' ? 'Image' : null;
    const likes       = metricDisplay(post.likes);
    const comments    = metricDisplay(post.comments);
    const reactions   = metricDisplay(post.reactions);
    const syncedLabel = post.last_synced_at ? timeAgo(post.last_synced_at) : null;
    const viewHref    = post.linkedin_post_id
      ? `https://www.linkedin.com/feed/update/${post.linkedin_post_id}/`
      : null;

    const syncedHtml = syncedLabel
      ? `<span class="pub-sync-timestamp" data-postid="${post.id}">Synced ${syncedLabel}</span>`
      : `<span class="pub-sync-timestamp" data-postid="${post.id}"></span>`;

    const viewHtml = viewHref
      ? `<a href="${viewHref}" target="_blank" rel="noopener noreferrer" class="pub-view-link">View on LinkedIn ↗</a>`
      : `<span class="pub-no-link">Not published</span>`;

    return `
      <div class="pub-card" data-postid="${post.id}">
        <div class="pub-card-main">
          <div class="pub-card-info">
            <div class="pub-card-top">
              <span class="pub-card-date">${dateStr}</span>
              ${archetype ? `<span class="pub-archetype-badge">${archetype}</span>` : ''}
              ${assetLabel ? `<span class="pub-asset-badge">${assetLabel}</span>` : ''}
            </div>
            ${hook ? `<p class="pub-card-hook">${hook}</p>` : ''}
          </div>
          <div class="pub-card-right">
            ${viewHtml}
            <div class="pub-card-metrics">
              <span class="pub-metric" title="Likes">
                <svg class="pub-metric-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                </svg>
                <span class="pub-metric-val" data-metric="likes">${likes}</span>
              </span>
              <span class="pub-metric" title="Comments">
                <svg class="pub-metric-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M2 5a2 2 0 012-2h12a2 2 0 012 2v7a2 2 0 01-2 2H6l-4 4V5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                </svg>
                <span class="pub-metric-val" data-metric="comments">${comments}</span>
              </span>
              <span class="pub-metric" title="Reactions">
                <svg class="pub-metric-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M2 11l8-8 8 8M4 9v8a1 1 0 001 1h4v-5h2v5h4a1 1 0 001-1V9" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                </svg>
                <span class="pub-metric-val" data-metric="reactions">${reactions}</span>
              </span>
              <button class="pub-sync-btn" data-postid="${post.id}" title="Refresh metrics from LinkedIn" aria-label="Refresh metrics">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                </svg>
              </button>
              ${syncedHtml}
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

  list.innerHTML = cards;

  list.querySelectorAll('.pub-sync-btn').forEach(btn => {
    btn.addEventListener('click', () => syncSinglePost(Number(btn.dataset.postid)));
  });
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Per-row sync
// ---------------------------------------------------------------------------

async function syncSinglePost(postId) {
  // Client-side cooldown guard
  const lastSync = syncTimestamps.get(postId);
  if (lastSync && Date.now() - lastSync < CLIENT_COOLDOWN_MS) {
    showToast('LinkedIn limits how often we can fetch fresh data. Please try again in a moment.', true);
    return;
  }

  const row     = document.querySelector(`.pub-card[data-postid="${postId}"]`);
  const btn     = row?.querySelector('.pub-sync-btn');
  const metrics = row?.querySelector('.pub-card-metrics');
  if (!row || !btn) return;

  // Enter loading state
  btn.classList.add('is-loading');
  btn.disabled = true;
  metrics?.classList.add('is-pulsing');

  try {
    const res  = await fetch('/api/linkedin/sync-metrics', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify({ postId }),
    });
    const data = await res.json();

    if (res.status === 429 || data.error === 'rate_limited') {
      showToast('LinkedIn sync limit reached. Please wait a moment before refreshing again.', true);
      return;
    }

    if (!data.ok) {
      const messages = {
        not_connected:    'LinkedIn is not connected. Please reconnect from your profile.',
        reconnect_required: 'LinkedIn session expired. Please reconnect.',
        no_linkedin_id:   'This post has no LinkedIn ID. Try publishing again.',
        post_not_found:   'Post not found.',
      };
      showToast(messages[data.error] || 'Sync failed. Please try again.', true);
      return;
    }

    // Update metrics in the DOM
    row.querySelector('[data-metric="likes"]').textContent    = metricDisplay(data.likes);
    row.querySelector('[data-metric="comments"]').textContent = metricDisplay(data.comments);
    row.querySelector('[data-metric="reactions"]').textContent = metricDisplay(data.reactions);

    const tsEl = row.querySelector('.pub-sync-timestamp');
    if (tsEl) tsEl.textContent = 'Updated just now';

    syncTimestamps.set(postId, Date.now());
  } catch {
    showToast('Could not reach the server. Check your connection.', true);
  } finally {
    btn.classList.remove('is-loading');
    btn.disabled = false;
    metrics?.classList.remove('is-pulsing');
  }
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
    const res  = await fetch('/api/posts?status=published', { headers: apiHeaders() });
    const data = await res.json();

    if (!data.ok || !Array.isArray(data.posts) || data.posts.length === 0) {
      renderEmpty();
    } else {
      renderStats(data.posts);
      renderList(data.posts);
    }
  } catch {
    renderEmpty();
  }
});

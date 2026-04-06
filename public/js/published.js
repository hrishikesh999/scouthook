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
      <p class="published-empty-msg">No published posts yet. Successes appear here once live.</p>
    </div>`;
}

function renderList(posts) {
  const list = document.getElementById('published-list');

  const rows = posts.map(post => {
    const dateStr     = formatDate(post.published_at);
    const archetype   = toTitleCase(post.format_slug);
    const words       = (post.content || '').trim().split(/\s+/);
    const preview     = words.slice(0, 12).join(' ') + (words.length > 12 ? '…' : '');
    const likes       = metricDisplay(post.likes);
    const comments    = metricDisplay(post.comments);
    const reactions   = metricDisplay(post.reactions);
    const syncedLabel = post.last_synced_at ? timeAgo(post.last_synced_at) : null;
    const viewHref    = post.linkedin_post_id
      ? `https://www.linkedin.com/feed/update/${post.linkedin_post_id}/`
      : null;

    const syncedHtml = syncedLabel
      ? `<span class="pub-sync-timestamp" data-postid="${post.id}">Updated ${syncedLabel}</span>`
      : `<span class="pub-sync-timestamp" data-postid="${post.id}"></span>`;

    const viewHtml = viewHref
      ? `<a href="${viewHref}" target="_blank" rel="noopener noreferrer" class="pub-view-link">View on LinkedIn ↗</a>`
      : `<span class="pub-view-link pub-view-link--disabled">—</span>`;

    return `
      <div class="published-row" data-postid="${post.id}">
        <span class="pub-col-date">${dateStr}</span>
        <span class="pub-col-archetype">
          <span class="pub-archetype-badge">${archetype}</span>
        </span>
        <span class="pub-col-content pub-serif">${preview}</span>
        <span class="pub-col-metrics">
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
          <button
            class="pub-sync-btn"
            data-postid="${post.id}"
            title="Refresh metrics from LinkedIn"
            aria-label="Refresh metrics for this post"
          >↻</button>
          ${syncedHtml}
        </span>
        <span class="pub-col-action">${viewHtml}</span>
      </div>`;
  }).join('');

  list.innerHTML = rows;

  // Attach click handlers to every sync button
  list.querySelectorAll('.pub-sync-btn').forEach(btn => {
    btn.addEventListener('click', () => syncSinglePost(Number(btn.dataset.postid)));
  });
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

  const row     = document.querySelector(`.published-row[data-postid="${postId}"]`);
  const btn     = row?.querySelector('.pub-sync-btn');
  const metrics = row?.querySelector('.pub-col-metrics');
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
// Topbar LinkedIn status (mirrors other pages)
// ---------------------------------------------------------------------------

async function checkLinkedInStatus() {
  try {
    const res  = await fetch('/api/linkedin/status', { headers: apiHeaders() });
    const data = await res.json();
    const btn  = document.getElementById('linkedin-connect-btn');
    if (!btn) return;
    if (data.connected) {
      btn.textContent = `✓ ${data.name || 'LinkedIn Connected'}`;
      btn.style.color = 'var(--score-pass)';
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
    const res  = await fetch('/api/posts?status=published', { headers: apiHeaders() });
    const data = await res.json();

    if (!data.ok || !Array.isArray(data.posts) || data.posts.length === 0) {
      renderEmpty();
    } else {
      renderList(data.posts);
    }
  } catch {
    renderEmpty();
  }
});

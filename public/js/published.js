/* published.js — Published page for Scouthook */

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
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

function renderList(posts) {
  const list = document.getElementById('published-list');

  const cards = posts.map(post => {
    const dateStr   = formatDate(post.published_at);
    const archetype = toTitleCase(post.format_slug);
    const hook      = escHtml(((post.content || '').trim().split('\n')[0] || '').trim());
    const assetLabel = post.asset_type === 'carousel' ? 'Carousel'
                     : post.asset_type === 'image'    ? 'Image'
                     : null;
    const viewHref  = post.linkedin_post_id
      ? `https://www.linkedin.com/feed/update/${post.linkedin_post_id}/`
      : null;

    return `
      <div class="pub-card">
        <div class="pub-card-main">
          <div class="pub-card-info">
            <div class="pub-card-top">
              <span class="pub-card-date">${dateStr}</span>
              ${archetype    ? `<span class="pub-archetype-badge">${archetype}</span>` : ''}
              ${post.funnel_type ? `<span class="funnel-badge ${post.funnel_type}">${post.funnel_type}</span>` : ''}
              ${assetLabel   ? `<span class="pub-asset-badge">${assetLabel}</span>` : ''}
            </div>
            ${hook ? `<p class="pub-card-hook">${hook}</p>` : ''}
          </div>
          <div class="pub-card-right">
            ${viewHref
              ? `<a href="${viewHref}" target="_blank" rel="noopener noreferrer" class="pub-view-btn">View on LinkedIn <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`
              : `<span class="pub-no-link">Not linked</span>`
            }
          </div>
        </div>
      </div>`;
  }).join('');

  list.innerHTML = cards;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
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

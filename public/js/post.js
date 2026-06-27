/* post.js — Published post detail page */

// POST_ID is resolved lazily in init() so SPA back-navigation picks up the current URL

const RATING_META = {
  strong: { emoji: '🔥', label: 'Strong' },
  decent: { emoji: '👍', label: 'Decent' },
  weak:   { emoji: '👎', label: 'Weak'   },
};

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
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function bodyToHtml(text) {
  // white-space: pre-line preserves intentional line breaks without turning
  // each blank line into a full-height paragraph (LinkedIn's own rendering)
  return `<div style="font-size:14px;line-height:1.55;color:#000;white-space:pre-line;font-family:-apple-system,system-ui,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif">${escHtml(text)}</div>`;
}

// ---------------------------------------------------------------------------
// Populate page
// ---------------------------------------------------------------------------

function populateMeta(post) {
  const archetype  = toTitleCase(post.format_slug);
  const assetLabel = post.asset_type === 'carousel' ? 'Carousel'
                   : post.asset_type === 'image'    ? 'Image'
                   : null;

  document.getElementById('post-page-meta').innerHTML = `
    <span class="pub-card-date">${formatDate(post.published_at)}</span>
    ${archetype        ? `<span class="pub-archetype-badge">${archetype}</span>` : ''}
    ${post.funnel_type ? `<span class="funnel-badge ${post.funnel_type}">${post.funnel_type}</span>` : ''}
    ${assetLabel       ? `<span class="pub-asset-badge">${assetLabel}</span>` : ''}
  `;

  document.title = `Post — Scouthook`;
}

function populateLiCard(post, profile) {
  const avatarEl = document.getElementById('post-li-avatar');
  const nameEl   = document.getElementById('post-li-name');
  const metaEl   = document.getElementById('post-li-meta');
  const bodyEl   = document.getElementById('post-li-body');

  if (profile) {
    nameEl.textContent = profile.name;
    metaEl.textContent = profile.headline;
    if (profile.photoUrl) {
      avatarEl.innerHTML = '';
      const img = document.createElement('img');
      img.src           = profile.photoUrl;
      img.alt           = profile.name;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%';
      avatarEl.appendChild(img);
    } else {
      avatarEl.textContent = profile.initials;
    }
  }

  bodyEl.innerHTML = bodyToHtml((post.content || '').trim());
}

function populateLinkedInLink(post) {
  if (!post.linkedin_post_id) return;
  const link = document.getElementById('post-li-link');
  link.href   = `https://www.linkedin.com/feed/update/${post.linkedin_post_id}/`;
  link.hidden = false;
}

// ---------------------------------------------------------------------------
// Performance rating
// ---------------------------------------------------------------------------

let currentTag = null;

function renderRating(tag) {
  currentTag = tag;
  const btnsWrap  = document.getElementById('post-rating-btns');
  const badgeWrap = document.getElementById('post-rated-badge');

  if (tag) {
    const meta = RATING_META[tag] || { emoji: '', label: tag };
    badgeWrap.textContent = `${meta.emoji} ${meta.label}`;
    badgeWrap.className   = `post-rated-badge post-rated-badge--${tag}`;
    badgeWrap.hidden      = false;
    btnsWrap.hidden       = true;
  } else {
    btnsWrap.hidden       = false;
    badgeWrap.hidden      = true;
  }
}

async function submitRating(tag) {
  const POST_ID = new URLSearchParams(window.location.search).get('id');
  const res  = await fetch(`/api/posts/${POST_ID}/performance`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...apiHeaders() },
    body:    JSON.stringify({ tag }),
  });
  const data = await res.json();
  if (data.ok) renderRating(tag);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function showPostError(msg) {
  const body = document.getElementById('post-li-body');
  if (body) body.innerHTML = `<p style="color:#666;font-size:14px;padding:12px 0">${msg}</p>`;
  const meta = document.getElementById('post-page-meta');
  if (meta) meta.innerHTML = '';
}

async function init() {
  const POST_ID = new URLSearchParams(window.location.search).get('id');
  if (!POST_ID) { window.location.replace('/Published.html'); return; }

  const ratingBtns = document.getElementById('post-rating-btns');
  if (ratingBtns) {
    ratingBtns.addEventListener('click', async e => {
      const btn = e.target.closest('[data-tag]');
      if (!btn) return;
      btn.disabled = true;
      await submitRating(btn.dataset.tag);
    });
  }

  try {
    // Use a prefetch started by the router (fired in parallel with the HTML fetch),
    // falling back to a fresh request if navigated directly or prefetch isn't available.
    const prefetchedPost = window.__routerConsumePrefetch?.(`/api/posts/${POST_ID}`);

    const [postResult, profileResult] = await Promise.allSettled([
      prefetchedPost || fetch(`/api/posts/${POST_ID}`, { headers: apiHeaders() }).then(r => r.json()),
      fetch('/api/linkedin/status', { headers: apiHeaders() }).then(r => r.json()),
    ]);

    const postData = postResult.status === 'fulfilled' ? postResult.value : null;
    if (!postData?.ok || !postData.post) {
      showPostError('Could not load this post. <a href="/Published.html" style="color:var(--teal)">Back to Published</a>');
      return;
    }

    const post = postData.post;

    let profile = null;
    if (profileResult.status === 'fulfilled' && profileResult.value?.connected) {
      const p = profileResult.value;
      profile = {
        name:     p.name     || '',
        headline: p.headline || '',
        photoUrl: p.photo_url || null,
        initials: p.name ? p.name.charAt(0).toUpperCase() : '',
      };
    }

    populateMeta(post);
    populateLiCard(post, profile);
    populateLinkedInLink(post);
    renderRating(post.performance_tag || null);
  } catch {
    showPostError('Something went wrong loading this post. <a href="/Published.html" style="color:var(--teal)">Back to Published</a>');
  }
}

window.__pageInit = init;
window.__pageCleanup = null;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

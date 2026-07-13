/* post.js — Published post detail page */

(function () {

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

// Mirror lib/assetType.js on the client: collapse any stored asset type — plus
// a URL-extension fallback — to the canonical 'image' | 'carousel' the card
// knows how to render. Keeps display working even if an un-normalized row slips
// through the API.
function canonicalAssetType(assetType, assetUrl) {
  const t = String(assetType || '').toLowerCase();
  if (t === 'image' || t === 'media_image' || t === 'html_template') return 'image';
  if (t === 'carousel' || t === 'media_pdf' || t === 'carousel_pack') return 'carousel';
  const url = String(assetUrl || '').split('?')[0].toLowerCase();
  if (/\.pdf$/.test(url)) return 'carousel';
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(url)) return 'image';
  return null;
}

function populateAsset(post) {
  const el = document.getElementById('post-li-asset');
  if (!el) return;

  const assetType = canonicalAssetType(post.asset_type, post.asset_url || post.asset_preview_url);

  if (assetType === 'image' && post.asset_url) {
    el.innerHTML = `<img src="${escHtml(post.asset_url)}" alt="Attached image" style="width:calc(100% + 32px);margin:8px -16px;display:block;max-height:560px;object-fit:cover" onerror="this.closest('#post-li-asset').hidden=true">`;
    el.hidden = false;
    return;
  }

  if (assetType === 'carousel') {
    const slideLabel = post.asset_slide_count > 1 ? `${post.asset_slide_count} slides` : 'Document';
    if (post.asset_preview_url) {
      el.innerHTML = `
        <a href="${escHtml(post.asset_url || post.asset_preview_url)}" target="_blank" rel="noopener noreferrer" style="display:block;margin:8px -16px;position:relative">
          <img src="${escHtml(post.asset_preview_url)}" alt="Carousel preview" style="width:100%;display:block;max-height:560px;object-fit:cover" onerror="this.style.display='none'">
          <span style="position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,0.65);color:#fff;font-size:11px;font-weight:600;padding:3px 8px;border-radius:4px">${escHtml(slideLabel)}</span>
        </a>`;
      el.hidden = false;
    } else if (post.asset_url) {
      el.innerHTML = `
        <a href="${escHtml(post.asset_url)}" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;gap:8px;margin:8px 0;padding:10px 12px;border:1px solid #e0e0e0;border-radius:8px;text-decoration:none;color:#0a66c2;font-size:13px;font-weight:600">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          View document (${escHtml(slideLabel)})
        </a>`;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
    return;
  }

  el.hidden = true;
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
  if (!POST_ID) { window.location.replace('/published.html'); return; }

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
    const directFetch = () =>
      fetch(`/api/posts/${POST_ID}`, { credentials: 'same-origin' }).then(r => r.json());

    // Use the router prefetch if available. If it resolved to null (any fetch error —
    // e.g. Neon cold-start, network blip) fall back to a direct fetch immediately.
    // Without this fallback a null-resolving Promise is still truthy, so the || branch
    // never runs and the page is permanently stuck on the skeleton / error state.
    const prefetchPromise = window.__routerConsumePrefetch?.(`/api/posts/${POST_ID}`);
    let postData;
    if (prefetchPromise) {
      postData = await prefetchPromise;
      if (!postData) postData = await directFetch();
    } else {
      postData = await directFetch();
    }

    // Cache linkedin/status — only name/avatar needed, no need to refetch for 2 min.
    const profilePromise  = cachedFetch('/api/linkedin/status', { credentials: 'same-origin' }, 120_000);
    if (!postData?.ok || !postData.post) {
      // Auto-recover: the most common cause is a Neon cold-start stalling the
      // prefetch. A hard navigation retries with a fresh connection (and Neon
      // is warmer from the previous attempt). Use sessionStorage to avoid a loop.
      const retryKey = `pst_retry:${POST_ID}`;
      try {
        if (!sessionStorage.getItem(retryKey)) {
          sessionStorage.setItem(retryKey, '1');
          window.location.replace(window.location.href);
          return;
        }
        sessionStorage.removeItem(retryKey);
      } catch { /* sessionStorage unavailable */ }
      showPostError('Could not load this post. <a href="/published.html" style="color:var(--teal)">Back to Published</a>');
      return;
    }
    try { sessionStorage.removeItem(`pst_retry:${POST_ID}`); } catch {}

    const post = postData.post;
    populateMeta(post);
    populateLiCard(post, null);
    populateAsset(post);
    populateLinkedInLink(post);
    renderRating(post.performance_tag || null);

    // Patch in LinkedIn profile (name / avatar / headline) when it arrives.
    profilePromise.then(p => {
      if (!p?.connected) return;
      const nameEl   = document.getElementById('post-li-name');
      const metaEl   = document.getElementById('post-li-meta');
      const avatarEl = document.getElementById('post-li-avatar');
      if (nameEl)   nameEl.textContent = p.name || '';
      if (metaEl)   metaEl.textContent = p.headline || '';
      if (avatarEl) {
        if (p.photo_url) {
          const img = document.createElement('img');
          img.src           = p.photo_url.trim();
          img.alt           = p.name || '';
          img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%';
          avatarEl.innerHTML = '';
          avatarEl.appendChild(img);
        } else if (p.name) {
          avatarEl.textContent = p.name.charAt(0).toUpperCase();
        }
      }
    }).catch(() => {});
  } catch {
    showPostError('Something went wrong loading this post. <a href="/published.html" style="color:var(--teal)">Back to Published</a>');
  }
}

window.__pageInit = init;
window.__pageCleanup = null;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();

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
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let allPosts  = [];
let liProfile = null;

const RATING_META = {
  strong: { emoji: '🔥', label: 'Strong' },
  decent: { emoji: '👍', label: 'Decent' },
  weak:   { emoji: '👎', label: 'Weak'   },
};

// ---------------------------------------------------------------------------
// LinkedIn profile (cached, fetched in parallel with posts)
// ---------------------------------------------------------------------------

async function loadLinkedInProfile() {
  try {
    const res  = await fetch('/api/linkedin/status', { credentials: 'include' });
    const data = await res.json();
    if (data.connected) {
      liProfile = {
        name:     data.name     || '',
        headline: data.headline || '',
        photoUrl: data.photo_url || null,
        initials: data.name ? data.name.charAt(0).toUpperCase() : '',
      };
    }
  } catch { /* modal degrades gracefully — shows empty card fields */ }
}

// ---------------------------------------------------------------------------
// Render list
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
    const dateStr    = formatDate(post.published_at);
    const archetype  = toTitleCase(post.format_slug);
    const hook       = escHtml(((post.content || '').trim().split('\n')[0] || '').trim());
    const assetLabel = post.asset_type === 'carousel' ? 'Carousel'
                     : post.asset_type === 'image'    ? 'Image'
                     : null;
    const perfMeta   = post.performance_tag ? RATING_META[post.performance_tag] : null;

    return `
      <div class="pub-card" data-post-id="${post.id}" role="button" tabindex="0" aria-label="Open post details">
        <div class="pub-card-main">
          <div class="pub-card-info">
            <div class="pub-card-top">
              <span class="pub-card-date">${dateStr}</span>
              ${archetype        ? `<span class="pub-archetype-badge">${archetype}</span>` : ''}
              ${post.funnel_type ? `<span class="funnel-badge ${post.funnel_type}">${post.funnel_type}</span>` : ''}
              ${assetLabel       ? `<span class="pub-asset-badge">${assetLabel}</span>` : ''}
              ${perfMeta         ? `<span class="pub-perf-badge pub-perf-badge--${post.performance_tag}">${perfMeta.emoji} ${perfMeta.label}</span>` : ''}
            </div>
            ${hook ? `<p class="pub-card-hook">${hook}</p>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  list.innerHTML = cards;

  list.querySelectorAll('.pub-card').forEach(card => {
    const postId = Number(card.dataset.postId);

    card.addEventListener('click', () => {
      const post = allPosts.find(p => p.id === postId);
      if (post) openDetail(post);
    });

    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const post = allPosts.find(p => p.id === postId);
        if (post) openDetail(post);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Modal — open / close
// ---------------------------------------------------------------------------

function openDetail(post) {
  const overlay = document.getElementById('pub-detail-overlay');

  const liLink = document.getElementById('pub-detail-li-link');
  if (post.linkedin_post_id) {
    liLink.href   = `https://www.linkedin.com/feed/update/${post.linkedin_post_id}/`;
    liLink.hidden = false;
  } else {
    liLink.hidden = true;
  }

  populateLiCard(post);
  renderModalRating(post);

  overlay.dataset.postId       = post.id;
  overlay.hidden               = false;
  document.body.style.overflow = 'hidden';
  document.getElementById('pub-detail-close').focus();
}

function closeDetail() {
  document.getElementById('pub-detail-overlay').hidden = true;
  document.body.style.overflow = '';
}

// ---------------------------------------------------------------------------
// LinkedIn card population
// ---------------------------------------------------------------------------

const SEE_MORE_THRESHOLD = 220;

function populateLiCard(post) {
  const avatarEl = document.getElementById('pub-li-avatar');
  const nameEl   = document.getElementById('pub-li-name');
  const metaEl   = document.getElementById('pub-li-meta');
  const bodyEl   = document.getElementById('pub-li-body');

  if (liProfile) {
    nameEl.textContent = liProfile.name;
    metaEl.textContent = liProfile.headline;
    if (liProfile.photoUrl) {
      avatarEl.innerHTML = '';
      const img = document.createElement('img');
      img.src           = liProfile.photoUrl;
      img.alt           = liProfile.name;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%';
      avatarEl.appendChild(img);
    } else {
      avatarEl.textContent = liProfile.initials;
    }
  }

  const content = (post.content || '').trim();
  bodyEl.innerHTML = '';

  if (content.length <= SEE_MORE_THRESHOLD) {
    bodyEl.innerHTML = bodyToHtml(content);
  } else {
    const truncated = content.slice(0, SEE_MORE_THRESHOLD);
    const rest      = content.slice(SEE_MORE_THRESHOLD);

    const truncEl = document.createElement('span');
    truncEl.innerHTML = bodyToHtml(truncated);

    const restEl = document.createElement('span');
    restEl.innerHTML = bodyToHtml(rest);
    restEl.hidden    = true;

    const seeMoreBtn = document.createElement('span');
    seeMoreBtn.className   = 'pub-see-more-btn';
    seeMoreBtn.textContent = '…see more';
    seeMoreBtn.addEventListener('click', () => {
      restEl.hidden = false;
      seeMoreBtn.remove();
    });

    bodyEl.appendChild(truncEl);
    bodyEl.appendChild(restEl);
    bodyEl.appendChild(seeMoreBtn);
  }
}

const LI_LINE_STYLE = `margin:0 0 6px;font-size:14px;line-height:1.55;color:#000;font-family:-apple-system,system-ui,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;

function bodyToHtml(text) {
  return text
    .split('\n')
    .map(line => `<p style="${LI_LINE_STYLE}">${escHtml(line) || '&nbsp;'}</p>`)
    .join('');
}

// ---------------------------------------------------------------------------
// Performance rating
// ---------------------------------------------------------------------------

function renderModalRating(post) {
  const btnsWrap  = document.getElementById('pub-detail-rating-btns');
  const badgeWrap = document.getElementById('pub-detail-rated-badge');

  if (post.performance_tag) {
    const meta = RATING_META[post.performance_tag] || { emoji: '', label: post.performance_tag };
    badgeWrap.textContent = `${meta.emoji} ${meta.label}`;
    badgeWrap.className   = `pub-detail-rated-badge pub-detail-rated-badge--${post.performance_tag}`;
    badgeWrap.hidden      = false;
    btnsWrap.hidden       = true;
  } else {
    btnsWrap.hidden       = false;
    badgeWrap.hidden      = true;
  }
}

async function submitRating(postId, tag) {
  try {
    const res  = await fetch(`/api/posts/${postId}/performance`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...apiHeaders() },
      body:    JSON.stringify({ tag }),
    });
    const data = await res.json();
    if (!data.ok) return;

    const post = allPosts.find(p => p.id === postId);
    if (!post) return;
    post.performance_tag = tag;
    renderModalRating(post);
    refreshCardBadge(postId, tag);
  } catch { /* silent */ }
}

function refreshCardBadge(postId, tag) {
  const top = document.querySelector(`.pub-card[data-post-id="${postId}"] .pub-card-top`);
  if (!top) return;
  top.querySelector('.pub-perf-badge')?.remove();
  const meta  = RATING_META[tag] || { emoji: '', label: tag };
  const badge = document.createElement('span');
  badge.className   = `pub-perf-badge pub-perf-badge--${tag}`;
  badge.textContent = `${meta.emoji} ${meta.label}`;
  top.appendChild(badge);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  // Wire modal controls
  document.getElementById('pub-detail-close').addEventListener('click', closeDetail);

  document.getElementById('pub-detail-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDetail();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('pub-detail-overlay').hidden) closeDetail();
  });

  document.getElementById('pub-detail-rating-btns').addEventListener('click', async e => {
    const btn = e.target.closest('[data-tag]');
    if (!btn) return;
    const tag    = btn.dataset.tag;
    const postId = Number(document.getElementById('pub-detail-overlay').dataset.postId);
    if (!postId || !tag) return;
    btn.disabled = true;
    await submitRating(postId, tag);
  });

  // Fetch LinkedIn profile in the background — will be ready well before user clicks
  loadLinkedInProfile();

  try {
    const res  = await fetch('/api/posts?status=published', { headers: apiHeaders() });
    const data = await res.json();

    if (!data.ok || !Array.isArray(data.posts) || data.posts.length === 0) {
      renderEmpty();
    } else {
      allPosts = data.posts;
      renderList(allPosts);
    }
  } catch {
    renderEmpty();
  }
});

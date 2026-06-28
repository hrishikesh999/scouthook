/* published.js — Published page for Scouthook */

function toTitleCase(str) {
  if (!str) return '';
  return str.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function formatDate(isoString) {
  if (!isoString) return '—';
  var d = new Date(isoString);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

var RATING_META = {
  strong: { emoji: '🔥', label: 'Strong' },
  decent: { emoji: '👍', label: 'Decent' },
  weak:   { emoji: '👎', label: 'Weak'   },
};

function renderEmpty() {
  var list = document.getElementById('published-list');
  if (!list) return;
  list.innerHTML = '<div class="published-empty">'
    + '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">'
    + '<path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452z"/>'
    + '</svg>'
    + '<p class="published-empty-title">Nothing published yet</p>'
    + '<p class="published-empty-msg">Your LinkedIn posts will appear here once published.</p>'
    + '<a href="/generate.html?new=1" class="published-empty-cta">Write your first post &rarr;</a>'
    + '</div>';
}

function renderList(posts) {
  var list = document.getElementById('published-list');
  if (!list) return;

  list.innerHTML = posts.map(function (post) {
    var dateStr    = formatDate(post.published_at);
    var archetype  = toTitleCase(post.format_slug);
    var hook       = escHtml(((post.content || '').trim().split('\n')[0] || '').trim());
    var assetLabel = post.asset_type === 'carousel' ? 'Carousel'
                   : post.asset_type === 'image'    ? 'Image'
                   : null;
    var perfMeta   = post.performance_tag ? RATING_META[post.performance_tag] : null;

    return '<a class="pub-card" href="/post.html?id=' + post.id + '" aria-label="View post from ' + escHtml(dateStr) + '">'
      + '<div class="pub-card-main">'
      + '<div class="pub-card-info">'
      + '<div class="pub-card-top">'
      + '<span class="pub-card-date">' + escHtml(dateStr) + '</span>'
      + (archetype ? '<span class="pub-archetype-badge">' + escHtml(archetype) + '</span>' : '')
      + (post.funnel_type ? '<span class="funnel-badge ' + escHtml(post.funnel_type) + '">' + escHtml(post.funnel_type) + '</span>' : '')
      + (assetLabel ? '<span class="pub-asset-badge">' + escHtml(assetLabel) + '</span>' : '')
      + (perfMeta ? '<span class="pub-perf-badge pub-perf-badge--' + escHtml(post.performance_tag) + '">' + perfMeta.emoji + ' ' + perfMeta.label + '</span>' : '')
      + '</div>'
      + (hook ? '<p class="pub-card-hook">' + hook + '</p>' : '')
      + '</div>'
      + '<div class="pub-card-right">'
      + '<span class="pub-view-post-btn">View post &rarr;</span>'
      + '</div>'
      + '</div>'
      + '</a>';
  }).join('');
}

function init() {
  cachedFetch('/api/posts?status=published', { headers: apiHeaders() }, 60000)
    .then(function (data) {
      if (!data.ok || !Array.isArray(data.posts) || data.posts.length === 0) {
        renderEmpty();
      } else {
        renderList(data.posts);
      }
    })
    .catch(function () {
      renderEmpty();
    });
}

window.__pageInit = init;
window.__pageCleanup = null;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

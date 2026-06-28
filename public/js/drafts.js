/* drafts.js — Drafts management page */

/* ── Helpers ─────────────────────────────────────────────────── */
function toTitleCase(str) {
  if (!str) return 'Post';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function hookLine(content) {
  var line = (content || '').split('\n').find(function (l) { return l.trim().length > 0; }) || '';
  return line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Render ──────────────────────────────────────────────────── */
function parseJsonResponse(res) {
  return res.text().then(function (text) {
    if (!text) return {};
    try { return JSON.parse(text); } catch (e) { return {}; }
  });
}

function deleteDraftErrorMessage(code) {
  var map = {
    post_not_found:              'This draft is no longer available.',
    only_drafts_deletable:       'Only drafts can be deleted.',
    cannot_delete_scheduled_post:'This post is scheduled — pause scheduling first.',
    missing_user_id:             'Session error — refresh the page and try again.',
    invalid_id:                  'Invalid draft — refresh the page.',
    delete_failed:               'Could not delete this draft. Try again.',
  };
  return (code && map[code]) ? map[code] : 'Could not delete this draft. Try again.';
}

function renderList(posts) {
  var container = document.getElementById('drafts-container');
  if (!container) return;

  var rows = posts.map(function (post) {
    var dateStr = post.created_at
      ? new Date(post.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      : '';
    var archetype = toTitleCase(post.format_slug);
    var hook      = hookLine(post.content);
    var url       = '/editor/' + encodeURIComponent(post.id);
    var pid       = String(post.id);

    var funnelBadge = post.funnel_type
      ? '<span class="funnel-badge ' + escAttr(post.funnel_type) + '">' + escAttr(post.funnel_type) + '</span>'
      : '';

    return '<div class="draft-row" data-post-id="' + escAttr(pid) + '" data-url="' + escAttr(url) + '">'
      + '<div class="draft-row-meta">'
      + '<span class="draft-row-date">' + escAttr(dateStr) + '</span>'
      + '<span class="pub-archetype-badge">' + escAttr(archetype) + '</span>'
      + funnelBadge
      + '</div>'
      + '<p class="draft-row-hook">' + hook + '</p>'
      + '<div class="draft-row-actions">'
      + '<button type="button" class="draft-row-delete" data-post-id="' + escAttr(pid) + '" aria-label="Delete draft">'
      + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>'
      + '</button>'
      + '</div>'
      + '</div>';
  }).join('');

  container.innerHTML = '<div id="drafts-list">' + rows + '</div>';
  bindDeleteButtons(container);
  bindRowClicks(container);
}

function renderEmpty() {
  var container = document.getElementById('drafts-container');
  if (!container) return;
  container.innerHTML = '<div class="drafts-empty">'
    + '<a href="/generate.html?new=1" class="btn-teal-filled">Create Your First Post</a>'
    + '<p class="drafts-empty-sub">You are one click away from an authoritative post.</p>'
    + '</div>';
}

function bindDeleteButtons(container) {
  container.querySelectorAll('.draft-row-delete').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var id = btn.getAttribute('data-post-id');
      if (!id) return;
      if (!window.confirm('Delete this draft? This cannot be undone.')) return;
      if (btn.dataset.deleting === '1') return;
      btn.dataset.deleting = '1';
      btn.disabled = true;

      fetch('/api/posts/' + encodeURIComponent(id) + '/delete', {
        method: 'POST',
        headers: apiHeaders(),
      })
        .then(function (res) { return parseJsonResponse(res).then(function (data) { return { res: res, data: data }; }); })
        .then(function (result) {
          if (!result.res.ok || !result.data.ok) throw new Error(deleteDraftErrorMessage(result.data.error));

          cachedFetch.bust('/api/posts');
          var row = btn.closest('.draft-row');
          if (row) row.remove();

          var remaining = document.querySelectorAll('.draft-row').length;
          var titleEl   = document.getElementById('drafts-title');
          if (titleEl) titleEl.textContent = remaining > 0 ? 'Drafts (' + remaining + ')' : 'Drafts';
          if (remaining === 0) renderEmpty();

          if (window.toast && window.toast.success) window.toast.success('Draft deleted.');
        })
        .catch(function (err) {
          if (window.toast && window.toast.error) window.toast.error(err.message || 'Could not delete draft. Please try again.');
          else window.alert(err.message || 'Could not delete draft');
          btn.disabled = false;
          btn.dataset.deleting = '';
        });
    });
  });
}

function bindRowClicks(container) {
  container.querySelectorAll('.draft-row').forEach(function (row) {
    row.addEventListener('click', function () {
      var url = row.getAttribute('data-url');
      if (url) window.location.href = url;
    });
  });
}

/* ── Init ────────────────────────────────────────────────────── */
function init() {
  if (sessionStorage.getItem('sh_just_published') === '1') {
    sessionStorage.removeItem('sh_just_published');
    cachedFetch.bust('/api/posts');
    cachedFetch.bust('/api/posts?status=published');
    if (window.toast && window.toast.success) window.toast.success('Post published successfully.');
    else {
      var banner = document.getElementById('publish-banner');
      if (banner) { banner.classList.remove('hidden'); setTimeout(function () { banner.classList.add('hidden'); }, 5000); }
    }
  }

  cachedFetch('/api/posts', { headers: apiHeaders() }, 60000)
    .then(function (data) {
      if (!data.ok || !Array.isArray(data.posts) || data.posts.length === 0) {
        renderEmpty();
      } else {
        var titleEl = document.getElementById('drafts-title');
        if (titleEl) titleEl.textContent = 'Drafts (' + data.posts.length + ')';
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

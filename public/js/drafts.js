/* drafts.js — Drafts management page */

/* ── Helpers ─────────────────────────────────────────────────── */
function qualityPillClass(score) {
  if (score == null || score < 50) return 'low';
  if (score >= 80) return 'good';
  return 'mid';
}

function toTitleCase(str) {
  if (!str) return 'Post';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function hookLine(content) {
  const line = (content || '').split('\n').find(l => l.trim().length > 0) || '';
  return line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── Render ──────────────────────────────────────────────────── */
async function parseJsonResponse(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

function deleteDraftErrorMessage(code) {
  const map = {
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
  const container = document.getElementById('drafts-container');

  const rows = posts.map(post => {
    const dateStr  = post.created_at
      ? new Date(post.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      : '';
    const archetype = toTitleCase(post.format_slug);
    const hook      = hookLine(post.content);
    const url       = `/preview.html?post_id=${encodeURIComponent(post.id)}`;
    const pid       = String(post.id);
    const score     = post.quality_score;
    const pillClass = qualityPillClass(score);
    const pillLabel = score != null ? score : '—';

    const funnelBadge = post.funnel_type
      ? `<span class="funnel-badge ${post.funnel_type}">${post.funnel_type}</span>` : '';

    return `
      <div class="draft-row" data-post-id="${pid}">
        <div class="draft-row-meta">
          <span class="draft-row-date">${dateStr}</span>
          <span class="pub-archetype-badge">${archetype}</span>
          ${funnelBadge}
          <span class="draft-quality-pill ${pillClass}">${pillLabel}</span>
        </div>
        <p class="draft-row-hook">${hook}</p>
        <div class="draft-row-actions">
          <a href="${url}" class="pub-view-btn">Refine →</a>
          <button type="button" class="draft-row-delete" data-post-id="${pid}" aria-label="Delete draft">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `<div id="drafts-list">${rows}</div>`;
  bindDeleteButtons(container);
}

function renderEmpty() {
  const container = document.getElementById('drafts-container');
  container.innerHTML = `
    <div class="drafts-empty">
      <a href="/generate.html?new=1" class="btn-teal-filled">Create Your First Post</a>
      <p class="drafts-empty-sub">You are one click away from an authoritative post.</p>
    </div>`;
}

function bindDeleteButtons(container) {
  container.querySelectorAll('.draft-row-delete').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute('data-post-id');
      if (!id) return;
      if (!window.confirm('Delete this draft? This cannot be undone.')) return;
      if (btn.dataset.deleting === '1') return;
      btn.dataset.deleting = '1';
      btn.disabled = true;
      try {
        const res  = await fetch(`/api/posts/${encodeURIComponent(id)}/delete`, {
          method: 'POST',
          headers: apiHeaders(),
        });
        const data = await parseJsonResponse(res);
        if (!res.ok || !data.ok) throw new Error(deleteDraftErrorMessage(data.error));

        const row = btn.closest('.draft-row');
        row?.remove();

        const remaining = document.querySelectorAll('.draft-row').length;
        const titleEl   = document.getElementById('drafts-title');
        if (titleEl) titleEl.textContent = remaining > 0 ? `Drafts (${remaining})` : 'Drafts';
        if (remaining === 0) renderEmpty();

        if (window.toast?.success) window.toast.success('Draft deleted.');
      } catch (err) {
        if (window.toast?.error) window.toast.error(err.message || 'Could not delete draft. Please try again.');
        else window.alert(err.message || 'Could not delete draft');
        btn.disabled = false;
        btn.dataset.deleting = '';
      }
    });
  });
}

/* ── Init ────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  if (sessionStorage.getItem('sh_just_published') === '1') {
    sessionStorage.removeItem('sh_just_published');
    if (window.toast?.success) window.toast.success('Post published successfully.');
    else {
      const banner = document.getElementById('publish-banner');
      if (banner) { banner.classList.remove('hidden'); setTimeout(() => banner.classList.add('hidden'), 5000); }
    }
  }

  try {
    const res  = await fetch('/api/posts', { headers: apiHeaders() });
    const data = await res.json();

    if (!data.ok || !Array.isArray(data.posts) || data.posts.length === 0) {
      renderEmpty();
    } else {
      const titleEl = document.getElementById('drafts-title');
      if (titleEl) titleEl.textContent = `Drafts (${data.posts.length})`;
      renderList(data.posts);
    }
  } catch {
    renderEmpty();
  }
});

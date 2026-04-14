/* drafts.js — Drafts management page */

/* ── Helpers ─────────────────────────────────────────────────── */
function scoreClass(score) {
  if (score == null) return 'empty';
  if (score >= 90) return 'elite';
  return 'mid';
}

function toTitleCase(str) {
  if (!str) return 'Post';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

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

/* ── LinkedIn status ─────────────────────────────────────────── */
async function checkLinkedInStatus() {
  const connectBtn = document.getElementById('linkedin-connect-btn');
  if (connectBtn) {
    connectBtn.href = `/api/linkedin/connect?_uid=${encodeURIComponent(getUserId())}&_tid=${encodeURIComponent(getTenantId())}`;
  }
  try {
    const res  = await fetch('/api/linkedin/status', { headers: apiHeaders() });
    const data = await res.json();
    const area = document.getElementById('nav-linkedin-area');
    if (data.connected && area) {
      area.innerHTML = buildLinkedInChip(data.name, data.photo_url);
    }
  } catch {
    // Leave default connect button
  }
}

/* ── Render ──────────────────────────────────────────────────── */
function deleteDraftErrorMessage(code) {
  const map = {
    post_not_found: 'This draft is no longer available.',
    only_drafts_deletable: 'Only drafts can be deleted.',
    cannot_delete_scheduled_post:
      'This post is scheduled and cannot be deleted. Pause scheduling on the compose page first.',
    missing_user_id: 'Session error — refresh the page and try again.',
    invalid_id: 'Invalid draft — refresh the page.',
    delete_failed: 'Could not delete this draft. Try again.',
  };
  if (code && map[code]) return map[code];
  return 'Could not delete this draft. Try again.';
}

async function parseJsonResponse(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function bindDeleteButtons(container) {
  container.querySelectorAll('.draft-delete-btn').forEach(btn => {
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
        // POST avoids proxies that strip or mishandle DELETE
        const res = await fetch(`/api/posts/${encodeURIComponent(id)}/delete`, {
          method: 'POST',
          headers: apiHeaders(),
        });
        const data = await parseJsonResponse(res);
        if (!res.ok || !data.ok) {
          throw new Error(deleteDraftErrorMessage(data.error));
        }
        const wrap = btn.closest('.draft-card-wrap');
        wrap?.remove();
        const grid = container.querySelector('.drafts-grid');
        const remaining = grid ? grid.querySelectorAll('.draft-card-wrap').length : 0;
        const titleEl = document.getElementById('drafts-title');
        if (titleEl) titleEl.textContent = `Drafts (${remaining})`;
        if (remaining === 0) renderEmpty();
        if (window.toast && typeof window.toast.success === 'function') {
          window.toast.success('Draft deleted.');
        }
      } catch (err) {
        if (window.toast && typeof window.toast.error === 'function') {
          window.toast.error(err.message || 'Couldn’t delete draft. Please try again.');
        } else {
          window.alert(err.message || 'Could not delete draft');
        }
        btn.disabled = false;
        btn.dataset.deleting = '';
      }
    });
  });
}

function renderGrid(posts) {
  const container = document.getElementById('drafts-container');

  const cards = posts.map(post => {
    const cls   = scoreClass(post.quality_score);
    const score = post.quality_score != null ? post.quality_score : '—';
    const label = toTitleCase(post.format_slug);
    const url   = `/generate.html?postId=${encodeURIComponent(post.id)}`;
    const text  = (post.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const pid   = String(post.id);

    return `
      <div class="draft-card-wrap">
        <a class="draft-card" href="${url}" aria-label="Refine post">
          <div class="draft-card-top">
            <span class="draft-archetype">${label}</span>
            <span class="draft-score ${cls}">${score}</span>
          </div>
          <p class="draft-preview">${text}</p>
          <span class="draft-cta">Refine Post →</span>
        </a>
        <button type="button" class="draft-delete-btn" data-post-id="${pid}" aria-label="Delete draft">
          Delete
        </button>
      </div>`;
  }).join('');

  container.innerHTML = `<div class="drafts-grid">${cards}</div>`;
  bindDeleteButtons(container);
}

function renderEmpty() {
  const container = document.getElementById('drafts-container');
  container.innerHTML = `
    <div class="drafts-empty">
      <a href="/generate.html?new=1" class="btn-teal-filled" style="display:inline-flex;text-decoration:none;">
        Create Your First Post
      </a>
      <p class="drafts-empty-sub">You are one click away from an authoritative post.</p>
    </div>`;
}

/* ── Init ────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  checkLinkedInStatus();

  // Show publish toast if navigated here after a successful publish
  if (sessionStorage.getItem('sh_just_published') === '1') {
    sessionStorage.removeItem('sh_just_published');
    if (window.toast && typeof window.toast.success === 'function') {
      window.toast.success('Post published successfully.');
    } else {
      const banner = document.getElementById('publish-banner');
      if (banner) {
        banner.classList.remove('hidden');
        setTimeout(() => banner.classList.add('hidden'), 5000);
      }
    }
  }

  try {
    const res  = await fetch('/api/posts', { headers: apiHeaders() });
    const data = await res.json();

    if (!data.ok || !Array.isArray(data.posts) || data.posts.length === 0) {
      renderEmpty();
    } else {
      // Update title with count
      const titleEl = document.getElementById('drafts-title');
      if (titleEl) titleEl.textContent = `Drafts (${data.posts.length})`;
      renderGrid(data.posts);
    }
  } catch {
    renderEmpty();
  }
});

/* members.js — Team members page logic
   Hard nav: initMembers() is called directly at the bottom of the IIFE.
   SPA re-nav: handled via spa:navigated event (not window.__pageInit, which
   is a shared global clobbered by every other page script). */

(function () {

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  var currentWorkspaceId     = null;
  var currentUserRole        = null;
  var currentUserId          = null;
  var currentUserEmail       = null;
  var currentUserDisplayName = null;
  var invitePlanGated        = false;

  async function loadMembers() {
    if (!currentWorkspaceId) return;
    const resp = await fetch(`/api/workspaces/${currentWorkspaceId}/members`, { credentials: 'same-origin' })
      .then(r => r.json()).catch(() => null);
    renderMembers(resp);
  }

  function renderMembers(data) {
    const list        = document.getElementById('members-list');
    const pendingWrap = document.getElementById('pending-invites-section');
    const pendingList = document.getElementById('pending-invites-list');
    if (!list) return;

    if (!data || !data.ok) {
      list.innerHTML = '<p class="vw-chips-empty">Unable to load members. Please refresh.</p>';
      return;
    }

    let members = data.members || [];
    const pending = data.pending_invites || [];

    // Fill in missing profile fields for the current user using session data
    members = members.map(m => {
      if (m.user_id !== currentUserId) return m;
      return {
        ...m,
        display_name: m.display_name || currentUserDisplayName,
        email:        m.email        || currentUserEmail,
      };
    });

    // If the owner has no workspace_members row, add a synthetic entry so they always see themselves
    if (currentUserId && !members.find(m => m.user_id === currentUserId)) {
      members = [{
        user_id:      currentUserId,
        role:         currentUserRole || 'owner',
        email:        currentUserEmail,
        display_name: currentUserDisplayName,
        joined_at:    null,
      }, ...members];
    }

    if (members.length === 0) {
      list.innerHTML = `
        <div style="text-align:center;padding:40px 24px">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--border)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto 16px" aria-hidden="true">
            <circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0-3-3.85"/>
          </svg>
          <p style="margin:0 0 6px;font-size:15px;font-weight:600;color:var(--text-heading)">No members yet</p>
          <p style="margin:0 0 20px;font-size:13px;color:var(--text-muted)">Invite teammates to collaborate on content in this workspace.</p>
          <button id="empty-invite-btn" class="vw-save-btn" type="button">Invite someone</button>
        </div>`;
      document.getElementById('empty-invite-btn').addEventListener('click', () => {
        const inviteEmail = document.getElementById('invite-email');
        if (inviteEmail) { inviteEmail.scrollIntoView({ behavior: 'smooth', block: 'center' }); inviteEmail.focus(); }
      });
    } else {
      list.innerHTML = members.map(m => {
        const isMe      = m.user_id === currentUserId;
        const canRemove = currentUserRole === 'owner' && !isMe;
        const youBadge  = isMe
          ? `<span style="background:#eef2ff;color:#4338ca;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:600;margin-right:4px">You</span>`
          : '';
        return `<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #f3f4f6">
          <div style="flex:1">
            <p style="margin:0;font-size:14px;font-weight:600;color:#111827">${escapeHtml(m.display_name || m.email)}</p>
            ${m.display_name ? `<p style="margin:0;font-size:12px;color:#9ca3af">${escapeHtml(m.email)}</p>` : ''}
          </div>
          ${youBadge}<span style="background:#f3f4f6;color:#6b7280;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:600;text-transform:capitalize">${escapeHtml(m.role)}</span>
          ${canRemove ? `<button class="vw-chip-remove" data-remove-user="${escapeHtml(m.user_id)}" type="button" title="Remove member" style="flex-shrink:0">✕</button>` : ''}
        </div>`;
      }).join('');

      list.querySelectorAll('[data-remove-user]').forEach(btn => {
        btn.addEventListener('click', () => removeMember(btn.dataset.removeUser));
      });
    }

    if (pendingWrap && pendingList) {
      if (pending.length > 0) {
        pendingWrap.style.display = 'block';
        pendingList.innerHTML = pending.map(inv => `
          <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #f3f4f6">
            <div style="flex:1">
              <p style="margin:0;font-size:14px;color:#374151">${escapeHtml(inv.email)}</p>
              <p style="margin:0;font-size:12px;color:#9ca3af">Expires ${new Date(inv.expires_at).toLocaleDateString()}</p>
            </div>
            <span style="background:#fffbeb;color:#92400e;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:600">Pending</span>
            <button class="vw-chip-remove" data-revoke-invite="${inv.id}" type="button" title="Revoke invite" style="flex-shrink:0">✕</button>
          </div>
        `).join('');
        pendingList.querySelectorAll('[data-revoke-invite]').forEach(btn => {
          btn.addEventListener('click', () => revokeInvite(Number(btn.dataset.revokeInvite)));
        });
      } else {
        pendingWrap.style.display = 'none';
      }
    }
  }

  async function removeMember(userId) {
    if (!confirm('Remove this member from the workspace?')) return;
    try {
      const r = await fetch(`/api/workspaces/${currentWorkspaceId}/members/${encodeURIComponent(userId)}`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      const d = await r.json();
      if (d.ok) loadMembers();
      else alert(d.error || 'Could not remove member.');
    } catch { alert('Network error.'); }
  }

  async function revokeInvite(inviteId) {
    if (!confirm('Cancel this invitation?')) return;
    try {
      const r = await fetch(`/api/workspaces/${currentWorkspaceId}/invites/${inviteId}`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      const d = await r.json();
      if (d.ok) loadMembers();
      else alert(d.error || 'Could not revoke invite.');
    } catch { alert('Network error.'); }
  }

  function wireInviteForm() {
    const inviteBtn    = document.getElementById('invite-btn');
    const inviteEmail  = document.getElementById('invite-email');
    const inviteStatus = document.getElementById('invite-status');
    if (!inviteBtn) return;

    inviteBtn.onclick = async () => {
      const email = (inviteEmail.value || '').trim();
      if (!email) { inviteEmail.focus(); return; }
      inviteBtn.disabled = true;
      inviteBtn.textContent = 'Sending…';
      inviteStatus.hidden = true;

      try {
        const r = await fetch(`/api/workspaces/${currentWorkspaceId}/invites`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const d = await r.json();
        if (d.ok) {
          inviteEmail.value = '';
          inviteStatus.textContent = 'Invitation sent.';
          inviteStatus.className = 'field-helper vw-save-status--ok';
          inviteStatus.hidden = false;
          loadMembers();
        } else {
          if (d.error === 'feature_not_available') {
            invitePlanGated = true;
            inviteStatus.innerHTML = 'Inviting teammates requires the <a href="/billing.html" style="color:inherit;font-weight:700;text-decoration:underline">Pro plan</a>. Upgrade to unlock team members.';
          } else {
            const msg = d.error === 'already_a_member'   ? 'This person is already a member.'
              : d.error === 'invite_already_pending'      ? 'An invitation is already pending for this email.'
              : (d.error || 'Failed to send invite.');
            inviteStatus.textContent = msg;
          }
          inviteStatus.className = 'field-helper vw-save-status--error';
          inviteStatus.hidden = false;
        }
      } catch {
        inviteStatus.textContent = 'Network error. Please try again.';
        inviteStatus.className = 'field-helper vw-save-status--error';
        inviteStatus.hidden = false;
      } finally {
        if (!invitePlanGated) {
          inviteBtn.disabled = false;
          inviteBtn.textContent = 'Send invite';
        }
      }
    };
  }

  function initMembers() {
    if (!document.getElementById('members-list')) return;

    // Reset state for re-init on SPA re-navigation
    currentWorkspaceId     = null;
    currentUserRole        = null;
    currentUserId          = null;
    currentUserEmail       = null;
    currentUserDisplayName = null;
    invitePlanGated        = false;

    wireInviteForm();

    window.scouthookAuthReady.then(authData => {
      const user = authData && authData.user;
      if (user) {
        currentWorkspaceId     = user.tenant_id;
        currentUserId          = user.user_id;
        currentUserEmail       = user.email       || null;
        currentUserDisplayName = user.displayName || null;
      }
      if (!currentWorkspaceId) {
        const list = document.getElementById('members-list');
        if (list) list.innerHTML = '<p class="vw-chips-empty">No workspace found. Please refresh or sign in again.</p>';
        return;
      }

      fetch(`/api/workspaces/${currentWorkspaceId}/members`, { credentials: 'same-origin' })
        .then(r => r.json())
        .then(d => {
          if (d.ok && Array.isArray(d.members)) {
            const me = d.members.find(m => m.user_id === currentUserId);
            if (me) currentUserRole = me.role;
          }
          renderMembers(d);
        })
        .catch(err => {
          console.error('[members] fetch failed', err);
          const list = document.getElementById('members-list');
          if (list) list.innerHTML = '<p class="vw-chips-empty">Unable to load members. Please refresh.</p>';
        });
    }).catch(err => {
      console.error('[members] auth failed', err);
      const list = document.getElementById('members-list');
      if (list) list.innerHTML = '<p class="vw-chips-empty">Unable to load members. Please refresh.</p>';
    });
  }

  // Hard-nav: run immediately on first load
  initMembers();

  // SPA re-nav: spa:navigated fires after every SPA navigation.
  // We use this instead of window.__pageInit because __pageInit is a shared
  // global that gets clobbered by whichever page script ran last — so on a
  // second visit via SPA the router ends up calling the wrong page's init.
  document.addEventListener('spa:navigated', function (e) {
    if (e.detail && (e.detail.pathname === '/members.html' || e.detail.pathname === '/workspace.html')) initMembers();
  });

})();

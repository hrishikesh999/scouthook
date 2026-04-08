/* profile.js — voice profile page logic */

const nicheEl      = document.getElementById('profile-niche');
const audienceEl   = document.getElementById('profile-audience');
const painEl       = document.getElementById('profile-pain');
const contrarianEl = document.getElementById('profile-contrarian');
const samplesEl    = document.getElementById('profile-samples');
const saveBtn      = document.getElementById('save-profile-btn');
const saveError    = document.getElementById('profile-save-error');
let reviewMode     = false;

async function loadConfig() {
  try {
    const res = await fetch('/api/config', { headers: apiHeaders() });
    const data = await res.json();
    reviewMode = !!data.review_mode;
  } catch {
    reviewMode = false;
  }
}

/* ── LinkedIn status in nav ──────────────────────────────────── */
function buildLinkedInChip(name, photoUrl) {
  const initials = name
    ? name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
    : '??';
  const avatarHtml = photoUrl
    ? `<img class="nav-linkedin-avatar" src="${photoUrl}" alt="${name || 'LinkedIn'}">`
    : `<div class="nav-linkedin-initials">${initials}</div>`;
  const nameHtml = name ? `<span class="nav-linkedin-name">${name}</span>` : '';
  return `
    <div class="nav-linkedin-connected" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
      <div style="display:flex;align-items:center;gap:8px;min-width:0;">
        ${avatarHtml}
        ${nameHtml}
      </div>
      <button
        type="button"
        class="nav-linkedin-disconnect"
        style="border:0;background:transparent;color:var(--text-muted);font-size:12px;padding:6px 6px;cursor:pointer;"
        aria-label="Disconnect LinkedIn"
        title="Disconnect"
      >Disconnect</button>
    </div>`;
}

async function disconnectLinkedIn() {
  try {
    await fetch('/api/linkedin/disconnect', { method: 'POST', headers: apiHeaders() });
  } catch { /* ignore */ }
  try { Session?.clear?.(); } catch { /* ignore */ }
  window.location.href = '/login.html';
}

(async function checkLinkedIn() {
  // Wire userId into the Connect LinkedIn button href
  const connectBtn = document.getElementById('linkedin-connect-btn');
  if (connectBtn) {
    connectBtn.href = `/api/linkedin/connect?_uid=${encodeURIComponent(getUserId())}&_tid=${encodeURIComponent(getTenantId())}`;
  }

  try {
    const res  = await fetch('/api/linkedin/status', { headers: apiHeaders() });
    const data = await res.json();
    const area = document.getElementById('nav-linkedin-area');
    if (data.connected) {
      area.innerHTML = buildLinkedInChip(data.name, data.photo_url);
      area.querySelector('.nav-linkedin-disconnect')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        disconnectLinkedIn();
      });
    }
  } catch {
    // Leave default button
  }
})();

/* ── Load existing profile ───────────────────────────────────── */
(async function loadProfile() {
  try {
    await loadConfig();
    const res  = await fetch(reviewMode ? '/api/profile/me' : `/api/profile/${getUserId()}`, { headers: apiHeaders() });
    const data = await res.json();
    if (!data.ok || !data.profile) return;

    const p = data.profile;
    if (p.content_niche)    nicheEl.value      = p.content_niche;
    if (p.audience_role)    audienceEl.value   = p.audience_role;
    if (p.audience_pain)    painEl.value       = p.audience_pain;
    if (p.contrarian_view)  contrarianEl.value = p.contrarian_view;
    // writing_samples is not returned by the API for privacy; leave blank
  } catch {
    // Leave fields blank
  }
})();

/* ── Save profile ────────────────────────────────────────────── */
saveBtn.addEventListener('click', async () => {
  saveError.classList.remove('visible');

  const body = {
    content_niche:    nicheEl.value.trim(),
    audience_role:    audienceEl.value.trim(),
    audience_pain:    painEl.value.trim(),
    contrarian_view:  contrarianEl.value.trim(),
    writing_samples:  samplesEl.value.trim()
  };

  // Remove empty fields so the backend doesn't reject with no_fields_provided
  // (at least one must be present)
  const hasAny = Object.values(body).some(v => v.length > 0);
  if (!hasAny) {
    saveError.textContent = 'Please fill in at least one field before saving.';
    saveError.classList.add('visible');
    return;
  }

  const origText = saveBtn.textContent;
  saveBtn.textContent = 'Saving…';
  saveBtn.disabled = true;

  try {
    const res  = await fetch('/api/profile', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(body)
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Save failed');
    }

    saveBtn.textContent = 'Saved ✓';
    setTimeout(() => {
      saveBtn.textContent = origText;
      saveBtn.disabled = false;
    }, 2000);

  } catch (err) {
    saveBtn.textContent = origText;
    saveBtn.disabled = false;
    saveError.textContent = err.message || 'Something went wrong. Try again.';
    saveError.classList.add('visible');
  }
});

/* media.js — Media Library page logic */

/* ── DOM refs ─────────────────────────────────────────────────── */
const mediaGrid      = document.getElementById('media-grid');
const uploadZone     = document.getElementById('media-upload-zone');
const fileInput      = document.getElementById('media-file-input');
const uploadProgress = document.getElementById('upload-progress');
const emptyMediaMsg  = document.getElementById('empty-media-msg');

/* ── State ────────────────────────────────────────────────────── */
let uploading = false;

/* ── LinkedIn status ──────────────────────────────────────────── */
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

async function checkLinkedInStatus() {
  const connectBtn = document.getElementById('linkedin-connect-btn');
  if (connectBtn) {
    connectBtn.href = `/api/linkedin/connect?_uid=${encodeURIComponent(getUserId())}&_tid=${encodeURIComponent(getTenantId())}`;
  }
  try {
    const res  = await fetch('/api/linkedin/status', { headers: apiHeaders() });
    const data = await res.json();
    const area = document.getElementById('nav-linkedin-area');
    if (!area) return;
    if (data.connected) {
      area.innerHTML = buildLinkedInChip(data.name, data.photo_url);
    }
  } catch { /* non-fatal */ }
}

/* ── Init ─────────────────────────────────────────────────────── */
(async function init() {
  await checkLinkedInStatus();
  await loadMedia();
})();

/* ── Load & render ────────────────────────────────────────────── */
async function loadMedia() {
  try {
    const res  = await fetch('/api/media', { headers: apiHeaders() });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    renderMedia(data.files);
  } catch {
    // Leave grid showing upload zone only
  }
}

function renderMedia(files) {
  // Remove all existing cards (keep upload zone as first child)
  const existing = mediaGrid.querySelectorAll('.media-card');
  existing.forEach(c => c.remove());

  if (emptyMediaMsg) {
    emptyMediaMsg.style.display = files.length === 0 ? '' : 'none';
  }

  files.forEach(f => mediaGrid.appendChild(buildCard(f)));
}

function buildCard(file) {
  const card = document.createElement('div');
  card.className = 'media-card';
  card.dataset.id = file.id;

  const isPdf = file.mime_type === 'application/pdf';

  card.innerHTML = `
    <div class="media-thumb">
      ${isPdf
        ? `<div class="media-pdf-thumb" aria-label="PDF file">
             <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
               <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
               <polyline points="14 2 14 8 20 8"/>
               <line x1="16" y1="13" x2="8" y2="13"/>
               <line x1="16" y1="17" x2="8" y2="17"/>
               <polyline points="10 9 9 9 8 9"/>
             </svg>
             <span>PDF</span>
           </div>`
        : `<img src="${file.url}" alt="${escHtml(file.filename)}" loading="lazy">`
      }
      <div class="media-card-actions">
        <button class="media-action-btn copy-btn" aria-label="Copy link" title="Copy link">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
        <button class="media-action-btn delete-btn" aria-label="Delete" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="media-card-info">
      <span class="media-filename" title="${escHtml(file.filename)}">${escHtml(truncName(file.filename))}</span>
      <span class="media-format-tag">${escHtml(file.format_tag || 'File')}</span>
    </div>
  `;

  card.querySelector('.copy-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    copyToClipboard(`${location.origin}${file.url}`, card.querySelector('.copy-btn'));
  });

  card.querySelector('.delete-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteMedia(file.id, card);
  });

  return card;
}

/* ── Upload ───────────────────────────────────────────────────── */
uploadZone.addEventListener('click', () => {
  if (!uploading) fileInput.click();
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) processFiles(Array.from(fileInput.files));
  fileInput.value = '';
});

uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('dragover');
});

uploadZone.addEventListener('dragleave', () => {
  uploadZone.classList.remove('dragover');
});

uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  const files = Array.from(e.dataTransfer.files);
  if (files.length) processFiles(files);
});

async function processFiles(files) {
  if (uploading) return;
  uploading = true;
  uploadZone.classList.add('uploading');
  if (uploadProgress) uploadProgress.style.display = '';

  for (const file of files) {
    try {
      await uploadFile(file);
    } catch (err) {
      showUploadError(err.message || 'Upload failed');
    }
  }

  uploading = false;
  uploadZone.classList.remove('uploading');
  if (uploadProgress) uploadProgress.style.display = 'none';
}

async function uploadFile(file) {
  const ALLOWED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
  if (!ALLOWED.includes(file.type)) {
    throw new Error(`${file.name}: unsupported type (JPG, PNG, GIF, WebP, PDF only)`);
  }
  if (file.size > 20 * 1024 * 1024) {
    throw new Error(`${file.name}: file exceeds 20 MB limit`);
  }

  const headers = {
    'Content-Type': file.type,
    'X-Filename':   encodeURIComponent(file.name),
    'X-User-Id':    getUserId(),
    'X-Tenant-Id':  getTenantId(),
  };

  let res;
  try {
    res = await fetch('/api/media/upload', { method: 'POST', headers, body: file });
  } catch {
    throw new Error('Network error — could not reach server');
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Upload failed (HTTP ${res.status})`);
  }

  if (!data.ok) throw new Error(data.error || 'Upload failed');

  const card = buildCard(data.file);
  uploadZone.insertAdjacentElement('afterend', card);
  if (emptyMediaMsg) emptyMediaMsg.style.display = 'none';
}

/* ── Delete ───────────────────────────────────────────────────── */
async function deleteMedia(id, cardEl) {
  if (!confirm('Delete this file? This cannot be undone.')) return;
  try {
    const res  = await fetch(`/api/media/${id}`, { method: 'DELETE', headers: apiHeaders() });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    cardEl.remove();
    // Show empty state if no cards left
    const remaining = mediaGrid.querySelectorAll('.media-card');
    if (emptyMediaMsg && remaining.length === 0) emptyMediaMsg.style.display = '';
  } catch (err) {
    alert(err.message || 'Could not delete file');
  }
}

/* ── Copy link ────────────────────────────────────────────────── */
async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.innerHTML;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
    setTimeout(() => { btn.innerHTML = orig; }, 1500);
  } catch {
    prompt('Copy this link:', text);
  }
}

/* ── Error toast ──────────────────────────────────────────────── */
function showUploadError(msg) {
  const toast = document.getElementById('media-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 4000);
}

/* ── Helpers ──────────────────────────────────────────────────── */
function truncName(name, max = 22) {
  if (name.length <= max) return name;
  const ext = name.lastIndexOf('.');
  if (ext > 0) {
    const base = name.slice(0, ext);
    const suffix = name.slice(ext);
    return base.slice(0, max - suffix.length - 1) + '…' + suffix;
  }
  return name.slice(0, max - 1) + '…';
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

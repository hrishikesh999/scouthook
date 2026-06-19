/* brand.js — Brand Settings page logic */

/* ── DOM refs ─────────────────────────────────────────────────── */
const brandNameEl           = document.getElementById('brand-name');
const bgSwatch              = document.getElementById('brand-bg-swatch');
const bgHex                 = document.getElementById('brand-bg-hex');
const accentSwatch          = document.getElementById('brand-accent-swatch');
const accentHex             = document.getElementById('brand-accent-hex');
const textSwatch            = document.getElementById('brand-text-swatch');
const textHex               = document.getElementById('brand-text-hex');
const secondaryBgSwatch     = document.getElementById('brand-secondary-bg-swatch');
const secondaryBgHex        = document.getElementById('brand-secondary-bg-hex');
const secondaryTextSwatch   = document.getElementById('brand-secondary-text-swatch');
const secondaryTextHex      = document.getElementById('brand-secondary-text-hex');
const fontHeadingEl         = document.getElementById('brand-font-heading');
const fontBodyEl            = document.getElementById('brand-font-body');
const fontHeadingPreview    = document.getElementById('brand-font-heading-preview');
const fontBodyPreview       = document.getElementById('brand-font-body-preview');
const logoUrlInput          = document.getElementById('brand-logo-url');
const logoThumb             = document.getElementById('brand-logo-thumb');
const logoPickBtn           = document.getElementById('brand-logo-pick-btn');
const logoUploadBtn         = document.getElementById('brand-logo-upload-btn');
const logoFileInput         = document.getElementById('brand-logo-file-input');
const logoUploading         = document.getElementById('brand-logo-uploading');
const logoClearBtn          = document.getElementById('brand-logo-clear-btn');
const saveBtn               = document.getElementById('brand-save-btn');
const saveStatus            = document.getElementById('brand-save-status');

const previewVisual     = document.getElementById('brand-preview-visual');
const previewAccentBar  = document.getElementById('brand-preview-accent-bar');
const previewLogoArea   = document.getElementById('brand-preview-logo-area');

const mediaOverlay      = document.getElementById('brand-media-overlay');
const brandOverlay      = document.getElementById('brand-overlay');
const mediaClose        = document.getElementById('brand-media-close');
const mediaGrid         = document.getElementById('brand-media-grid');
const mediaEmpty        = document.getElementById('brand-media-empty');

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
    if (data.connected) area.innerHTML = buildLinkedInChip(data.name, data.photo_url);
  } catch { /* non-fatal */ }
}

/* ── Init ─────────────────────────────────────────────────────── */
async function init() {
  await window.scouthookAuthReady;
  await checkLinkedInStatus();
  await loadBrand();
}

window.__pageInit = init;
window.__pageCleanup = null;
init();

/* ── Load saved brand ─────────────────────────────────────────── */
async function loadBrand() {
  try {
    const res  = await fetch(`/api/profile/${encodeURIComponent(getUserId())}`, { headers: apiHeaders() });
    const data = await res.json();
    if (!data.ok || !data.profile) return;
    const p = data.profile;

    brandNameEl.value = p.brand_name || '';
    setColor('bg',     p.brand_bg     || '#0F1A3C');
    setColor('accent', p.brand_accent || '#0D7A5F');
    setColor('text',   p.brand_text   || '#F0F4FF');
    if (p.brand_secondary_bg)   setOptionalColor('secondary-bg',   p.brand_secondary_bg);
    if (p.brand_secondary_text) setOptionalColor('secondary-text', p.brand_secondary_text);
    if (p.brand_logo) setLogo(p.brand_logo);
    if (p.brand_font_heading) { fontHeadingEl.value = p.brand_font_heading; applyFontPreview('heading', p.brand_font_heading); }
    if (p.brand_font_body)    { fontBodyEl.value    = p.brand_font_body;    applyFontPreview('body',    p.brand_font_body); }

    updatePreview();
  } catch { /* leave defaults */ }
}

/* ── Color helpers ────────────────────────────────────────────── */
function setColor(key, hex) {
  const swatch = document.getElementById(`brand-${key}-swatch`);
  const input  = document.getElementById(`brand-${key}-hex`);
  if (swatch) swatch.value = hex;
  if (input)  input.value  = hex;
}

function setOptionalColor(key, hex) {
  setColor(key, hex);
}

function wireColorPair(key) {
  const swatch = document.getElementById(`brand-${key}-swatch`);
  const input  = document.getElementById(`brand-${key}-hex`);
  if (!swatch || !input) return;

  swatch.addEventListener('input', () => {
    input.value = swatch.value;
    updatePreview();
  });

  input.addEventListener('input', () => {
    const val = input.value.trim();
    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
      swatch.value = val;
      updatePreview();
    }
  });

  input.addEventListener('blur', () => {
    let val = input.value.trim();
    if (!val) return; // allow empty for optional fields
    if (/^[0-9A-Fa-f]{6}$/.test(val)) val = '#' + val;
    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
      input.value  = val;
      swatch.value = val;
    } else {
      input.value  = swatch.value;
    }
    updatePreview();
  });
}

wireColorPair('bg');
wireColorPair('accent');
wireColorPair('text');
wireColorPair('secondary-bg');
wireColorPair('secondary-text');

brandNameEl.addEventListener('input', updatePreview);

/* ── Font helpers ─────────────────────────────────────────────── */
function loadGoogleFont(fontName) {
  if (!fontName) return;
  const id = `gfont-${fontName.replace(/\s+/g, '-')}`;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id   = id;
  link.rel  = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;700&display=swap`;
  document.head.appendChild(link);
}

function applyFontPreview(which, fontName) {
  const preview = which === 'heading' ? fontHeadingPreview : fontBodyPreview;
  if (!fontName) { preview.textContent = ''; preview.style.fontFamily = ''; return; }
  loadGoogleFont(fontName);
  preview.style.fontFamily = `'${fontName}', sans-serif`;
  preview.textContent = `${fontName} — The quick brown fox jumps over the lazy dog`;
}

let _fontHeadingTimer, _fontBodyTimer;
fontHeadingEl.addEventListener('input', () => {
  clearTimeout(_fontHeadingTimer);
  _fontHeadingTimer = setTimeout(() => applyFontPreview('heading', fontHeadingEl.value.trim()), 600);
});
fontBodyEl.addEventListener('input', () => {
  clearTimeout(_fontBodyTimer);
  _fontBodyTimer = setTimeout(() => applyFontPreview('body', fontBodyEl.value.trim()), 600);
});

/* ── Live preview ─────────────────────────────────────────────── */
function updatePreview() {
  const bg     = bgHex.value     || '#0F1A3C';
  const accent = accentHex.value || '#0D7A5F';
  const text   = textHex.value   || '#F0F4FF';
  const name   = brandNameEl.value.trim();
  const logo   = logoUrlInput.value;

  previewVisual.style.background   = bg;
  previewAccentBar.style.background = accent;

  document.getElementById('brand-preview-quote').style.color = text;

  // Footer: logo or brand name
  if (logo) {
    previewLogoArea.innerHTML = `<img src="${escHtml(logo)}" class="brand-preview-logo-img" alt="Brand logo">`;
  } else if (name) {
    previewLogoArea.innerHTML = `<span class="brand-preview-name" style="color:${escHtml(text)}">${escHtml(name)}</span>`;
  } else {
    previewLogoArea.innerHTML = '';
  }
}

/* ── Logo picker ──────────────────────────────────────────────── */
function setLogo(url) {
  logoUrlInput.value = url;
  logoThumb.innerHTML = `<img src="${escHtml(url)}" alt="Brand logo" style="width:100%;height:100%;object-fit:contain;border-radius:4px;">`;
  logoClearBtn.style.display = '';
  updatePreview();
}

function clearLogo() {
  logoUrlInput.value  = '';
  logoThumb.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  logoClearBtn.style.display = 'none';
  updatePreview();
}

logoClearBtn.addEventListener('click', clearLogo);

/* ── Logo upload ──────────────────────────────────────────────── */
logoUploadBtn.addEventListener('click', () => logoFileInput.click());

logoFileInput.addEventListener('change', async () => {
  const file = logoFileInput.files[0];
  if (!file) return;
  logoFileInput.value = '';

  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!ALLOWED.includes(file.type)) {
    if (window.toast && typeof window.toast.error === 'function') {
      window.toast.error('Logo upload failed: unsupported file type.');
    }
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    if (window.toast && typeof window.toast.error === 'function') {
      window.toast.error('Logo upload failed: file exceeds 20 MB.');
    }
    return;
  }

  logoUploadBtn.disabled = true;
  logoUploading.style.display = '';

  try {
    const res = await fetch('/api/media/upload', {
      method: 'POST',
      headers: {
        'Content-Type': file.type,
        'X-Filename':   encodeURIComponent(file.name),
        'X-User-Id':    getUserId(),
        'X-Tenant-Id':  getTenantId(),
      },
      body: file,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Upload failed');
    setLogo(data.file.url);
    if (window.toast && typeof window.toast.success === 'function') {
      window.toast.success('Logo uploaded successfully.');
    }
  } catch (err) {
    if (window.toast && typeof window.toast.error === 'function') {
      window.toast.error(err.message || 'Logo upload failed. Please try again.');
    }
  } finally {
    logoUploadBtn.disabled = false;
    logoUploading.style.display = 'none';
  }
});

logoPickBtn.addEventListener('click', openMediaPicker);

function openMediaPicker() {
  mediaOverlay.classList.add('visible');
  mediaOverlay.setAttribute('aria-hidden', 'false');
  brandOverlay.classList.add('visible');
  loadMediaForPicker();
}

function closeMediaPicker() {
  mediaOverlay.classList.remove('visible');
  mediaOverlay.setAttribute('aria-hidden', 'true');
  brandOverlay.classList.remove('visible');
}

mediaClose.addEventListener('click', closeMediaPicker);
brandOverlay.addEventListener('click', closeMediaPicker);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mediaOverlay.classList.contains('visible')) closeMediaPicker();
});

async function loadMediaForPicker() {
  // Clear existing tiles (keep empty msg)
  Array.from(mediaGrid.children).forEach(c => {
    if (c !== mediaEmpty) c.remove();
  });

  try {
    const res  = await fetch('/api/media', { headers: apiHeaders() });
    const data = await res.json();
    if (!data.ok) throw new Error();

    const images = (data.files || []).filter(f => f.mime_type && f.mime_type.startsWith('image/'));

    if (images.length === 0) {
      mediaEmpty.style.display = '';
      return;
    }
    mediaEmpty.style.display = 'none';

    images.forEach(f => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'brand-media-tile';
      tile.title = f.filename;
      tile.innerHTML = `<img src="${escHtml(f.url)}" alt="${escHtml(f.filename)}" loading="lazy">`;
      tile.addEventListener('click', () => {
        setLogo(f.url);
        closeMediaPicker();
      });
      mediaGrid.appendChild(tile);
    });
  } catch {
    mediaEmpty.textContent = 'Could not load media library.';
    mediaEmpty.style.display = '';
  }
}

/* ── Save ─────────────────────────────────────────────────────── */
saveBtn.addEventListener('click', async () => {
  saveStatus.textContent = '';
  saveStatus.className   = 'brand-save-status';

  const body = {
    brand_name:           brandNameEl.value.trim()        || null,
    brand_bg:             bgHex.value                     || null,
    brand_accent:         accentHex.value                 || null,
    brand_text:           textHex.value                   || null,
    brand_logo:           logoUrlInput.value              || null,
    brand_secondary_bg:   secondaryBgHex.value.trim()     || null,
    brand_secondary_text: secondaryTextHex.value.trim()   || null,
    brand_font_heading:   fontHeadingEl.value.trim()      || null,
    brand_font_body:      fontBodyEl.value.trim()         || null,
  };

  const origText = saveBtn.textContent;
  saveBtn.textContent = 'Saving…';
  saveBtn.disabled = true;

  try {
    const res  = await fetch('/api/profile', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Save failed');

    saveBtn.textContent = 'Saved ✓';
    if (window.toast && typeof window.toast.success === 'function') {
      window.toast.success('Brand settings updated successfully.');
    }
    setTimeout(() => {
      saveBtn.textContent = origText;
      saveBtn.disabled = false;
    }, 2000);
  } catch (err) {
    saveBtn.textContent = origText;
    saveBtn.disabled = false;
    saveStatus.textContent = err.message || 'Could not save. Try again.';
    saveStatus.classList.add('error');
    if (window.toast && typeof window.toast.error === 'function') {
      window.toast.error('Couldn’t update brand settings. Please try again.');
    }
  }
});

/* ── Helpers ──────────────────────────────────────────────────── */
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

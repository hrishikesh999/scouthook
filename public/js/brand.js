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
    if (p.brand_font_heading) { headingCombo.setValue(p.brand_font_heading); applyFontPreview('heading', p.brand_font_heading); }
    if (p.brand_font_body)    { bodyCombo.setValue(p.brand_font_body);       applyFontPreview('body',    p.brand_font_body); }

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

/* ── Google Fonts list ────────────────────────────────────────── */
const POPULAR_FONTS = [
  'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Raleway',
  'Nunito', 'Oswald', 'Source Sans 3', 'PT Sans', 'Ubuntu', 'Noto Sans',
  'Rubik', 'Work Sans', 'DM Sans', 'Plus Jakarta Sans', 'Jost', 'Mulish',
  'Outfit', 'Barlow', 'Karla', 'IBM Plex Sans', 'Figtree', 'Manrope',
  'Quicksand', 'Cabin', 'Fira Sans', 'Titillium Web', 'Josefin Sans',
  'Playfair Display', 'Merriweather', 'Lora', 'EB Garamond', 'Libre Baskerville',
  'Cormorant Garamond', 'DM Serif Display', 'Spectral', 'Vollkorn', 'Crimson Pro',
  'Bebas Neue', 'Anton', 'Abril Fatface', 'Righteous', 'Russo One',
  'Dancing Script', 'Caveat', 'Pacifico', 'Permanent Marker', 'Roboto Mono',
];

const ALL_FONTS = [
  'Abel', 'Abril Fatface', 'Alegreya', 'Alegreya Sans', 'Alegreya Sans SC', 'Alegreya SC',
  'Alfa Slab One', 'Amatic SC', 'Anton', 'Archivo', 'Archivo Black', 'Archivo Narrow',
  'Arimo', 'Arvo', 'Asap', 'Assistant', 'Audiowide',
  'Barlow', 'Barlow Condensed', 'Barlow Semi Condensed', 'Be Vietnam Pro',
  'Bebas Neue', 'BioRhyme', 'Bitter', 'Bodoni Moda', 'Boogaloo', 'Brygada 1918',
  'Bubblegum Sans', 'Cabin', 'Cairo', 'Cantarell', 'Cardo', 'Catamaran',
  'Caveat', 'Chakra Petch', 'Chewy', 'Chivo', 'Cinzel', 'Cinzel Decorative',
  'Comfortaa', 'Commissioner', 'Cookie', 'Cormorant', 'Cormorant Garamond',
  'Courgette', 'Courier Prime', 'Crimson Pro', 'Crimson Text',
  'DM Mono', 'DM Sans', 'DM Serif Display', 'DM Serif Text',
  'Dancing Script', 'Domine', 'Dosis',
  'EB Garamond', 'Encode Sans', 'Exo', 'Exo 2',
  'Faustina', 'Figtree', 'Fira Code', 'Fira Mono', 'Fira Sans', 'Fira Sans Condensed',
  'Fjalla One', 'Francois One', 'Frank Ruhl Libre', 'Fraunces', 'Fredoka', 'Fredoka One',
  'Fugaz One', 'Geist', 'Geologica', 'Gloria Hallelujah', 'Gochi Hand',
  'Grand Hotel', 'Gravitas One', 'Gugi',
  'Hanken Grotesk', 'Handlee', 'Heebo', 'Hind',
  'IBM Plex Mono', 'IBM Plex Sans', 'IBM Plex Serif', 'Inconsolata', 'Indie Flower', 'Inter',
  'JetBrains Mono', 'Josefin Sans', 'Josefin Slab', 'Jost',
  'Kalam', 'Kanit', 'Karla', 'Kaushan Script', 'Kreon', 'Kumbh Sans',
  'Lato', 'Leckerli One', 'Lexend', 'Libre Baskerville', 'Libre Franklin',
  'Lilita One', 'Literata', 'Lobster', 'Lobster Two', 'Lora', 'Luckiest Guy',
  'M PLUS 1p', 'M PLUS Rounded 1c', 'Manrope', 'Marcellus', 'Martel', 'Martel Sans',
  'Martian Mono', 'Maven Pro', 'Merienda', 'Merriweather', 'Merriweather Sans',
  'Michroma', 'Monoton', 'Montserrat', 'Montserrat Alternates', 'Mukta', 'Mulish',
  'Nanum Gothic', 'Neuton', 'Niramit', 'Noticia Text', 'Noto Sans', 'Noto Sans Mono',
  'Noto Serif', 'Nunito', 'Nunito Sans',
  'Old Standard TT', 'Onest', 'Open Sans', 'Oswald', 'Outfit', 'Overpass', 'Overpass Mono',
  'Oxygen', 'PT Mono', 'PT Sans', 'PT Serif', 'Pacifico', 'Palanquin', 'Patua One',
  'Permanent Marker', 'Philosopher', 'Playfair Display', 'Playfair Display SC',
  'Plus Jakarta Sans', 'Podkova', 'Poppins', 'Press Start 2P', 'Prompt', 'Public Sans',
  'Quattrocento', 'Questrial', 'Quicksand',
  'Racing Sans One', 'Raleway', 'Rasa', 'Recursive', 'Red Hat Display', 'Red Hat Text',
  'Righteous', 'Roboto', 'Roboto Condensed', 'Roboto Mono', 'Rokkitt', 'Rowdies', 'Rubik',
  'Russo One', 'Sacramento', 'Saira', 'Sarabun', 'Satisfy', 'Sen',
  'Shadows Into Light', 'Sigmar One', 'Signika', 'Slabo 27px',
  'Source Code Pro', 'Source Sans 3', 'Space Grotesk', 'Space Mono', 'Special Elite',
  'Spectral', 'Syne', 'Tangerine', 'Tajawal', 'Teko', 'Titillium Web',
  'Titan One', 'Tinos', 'Ubuntu', 'Ubuntu Mono', 'Ultra', 'Urbanist',
  'VT323', 'Varela Round', 'Vollkorn', 'Work Sans',
  'Yantramanav', 'Yellowtail', 'Yeseva One', 'Zeyada', 'Zilla Slab',
];

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
  if (!fontName) { preview.textContent = ''; preview.style.fontFamily = ''; }
  else {
    loadGoogleFont(fontName);
    preview.style.fontFamily = `'${fontName}', sans-serif`;
    preview.textContent = `${fontName} — The quick brown fox jumps over the lazy dog`;
  }
  updatePreview();
}

/* ── Font combobox ────────────────────────────────────────────── */
function makeFontCombobox(inputEl, listEl, which) {
  let selectedFont = '';
  let activeIndex  = -1;
  let isOpen       = false;

  function getMatches(query) {
    const q = query.trim().toLowerCase();
    if (!q) return POPULAR_FONTS;
    return ALL_FONTS.filter(f => f.toLowerCase().includes(q)).slice(0, 50);
  }

  function renderList(query) {
    listEl.innerHTML = '';
    activeIndex = -1;
    const fonts = getMatches(query);

    if (!query.trim()) {
      const hdr = document.createElement('li');
      hdr.className = 'font-combobox-section-header';
      hdr.textContent = 'Popular fonts';
      listEl.appendChild(hdr);
    }

    if (fonts.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'font-combobox-no-results';
      empty.textContent = 'No matching fonts';
      listEl.appendChild(empty);
      return;
    }

    fonts.forEach(fontName => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.font = fontName;
      li.textContent  = fontName;
      li.style.fontFamily = `'${fontName}', sans-serif`;
      loadGoogleFont(fontName);
      if (fontName === selectedFont) li.classList.add('selected');
      li.addEventListener('mousedown', e => {
        e.preventDefault();
        selectFont(fontName);
      });
      listEl.appendChild(li);
    });
  }

  function openDropdown() {
    if (isOpen) return;
    isOpen = true;
    renderList(inputEl.value);
    listEl.classList.add('open');
    inputEl.setAttribute('aria-expanded', 'true');
  }

  function closeDropdown() {
    if (!isOpen) return;
    isOpen = false;
    listEl.classList.remove('open');
    inputEl.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
  }

  function selectFont(fontName) {
    selectedFont    = fontName;
    inputEl.value   = fontName;
    closeDropdown();
    applyFontPreview(which, fontName);
  }

  function getOptionItems() {
    return Array.from(listEl.querySelectorAll('li[role="option"]'));
  }

  function setActive(items, idx) {
    items.forEach((item, i) => item.classList.toggle('active', i === idx));
    if (idx >= 0 && items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
  }

  inputEl.addEventListener('focus', () => openDropdown());

  inputEl.addEventListener('input', () => {
    if (!isOpen) openDropdown();
    renderList(inputEl.value);
    if (!inputEl.value.trim()) {
      selectedFont = '';
      applyFontPreview(which, '');
    }
  });

  inputEl.addEventListener('keydown', e => {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); openDropdown(); }
      return;
    }
    const items = getOptionItems();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      setActive(items, activeIndex);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      setActive(items, activeIndex);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && items[activeIndex]) {
        selectFont(items[activeIndex].dataset.font);
      }
    } else if (e.key === 'Escape') {
      closeDropdown();
      inputEl.value = selectedFont;
    }
  });

  inputEl.addEventListener('blur', () => {
    setTimeout(() => {
      closeDropdown();
      if (!inputEl.value.trim()) {
        selectedFont = '';
        applyFontPreview(which, '');
      } else {
        inputEl.value = selectedFont;
      }
    }, 150);
  });

  return {
    setValue(fontName) {
      selectedFont  = fontName || '';
      inputEl.value = fontName || '';
    },
  };
}

const fontHeadingListEl = document.getElementById('brand-font-heading-list');
const fontBodyListEl    = document.getElementById('brand-font-body-list');
const headingCombo = makeFontCombobox(fontHeadingEl, fontHeadingListEl, 'heading');
const bodyCombo    = makeFontCombobox(fontBodyEl,    fontBodyListEl,    'body');

/* ── Live preview ─────────────────────────────────────────────── */
function updatePreview() {
  const bg           = bgHex.value                    || '#0F1A3C';
  const accent       = accentHex.value                || '#0D7A5F';
  const text         = textHex.value                  || '#F0F4FF';
  const secondaryBg  = secondaryBgHex.value.trim()    || null;
  const secondaryTxt = secondaryTextHex.value.trim()  || null;
  const name         = brandNameEl.value.trim();
  const logo         = logoUrlInput.value;
  const headingFont  = fontHeadingEl.value.trim();
  const bodyFont     = fontBodyEl.value.trim();

  const headingFF = headingFont ? `'${headingFont}', sans-serif` : 'inherit';
  const bodyFF    = bodyFont    ? `'${bodyFont}', sans-serif`    : 'inherit';

  function logoHtml() {
    if (logo) return `<img src="${escHtml(logo)}" alt="Brand logo">`;
    if (name) return `<span class="bpv-brand-name" style="color:${escHtml(text)}">${escHtml(name)}</span>`;
    return '';
  }

  // ── Quote ────────────────────────────────────────────────────
  el('bpv-quote',       e => { e.style.background = bg; });
  el('bpv-accent-bar',  e => { e.style.background = accent; });
  el('bpv-quote-text',  e => { e.style.color = text; e.style.fontFamily = headingFF; });
  el('bpv-quote-logo',  e => { e.innerHTML = logoHtml(); });

  // ── Branded Quote ─────────────────────────────────────────────
  el('bpv-branded',        e => { e.style.background = bg; });
  el('bpv-bq-card',        e => { e.style.background = secondaryBg || 'rgba(255,255,255,0.07)'; });
  el('bpv-bq-bar',         e => { e.style.background = accent; });
  el('bpv-bq-quote',       e => { e.style.color = text; e.style.fontFamily = headingFF; });
  el('bpv-bq-attribution', e => { e.style.color = secondaryTxt || text; e.style.fontFamily = bodyFF; });
  el('bpv-branded-logo',   e => { e.innerHTML = logoHtml(); });

  // ── Carousel ──────────────────────────────────────────────────
  ['bpv-cs-1', 'bpv-cs-2'].forEach(id => el(id, e => { e.style.background = bg; }));
  el('bpv-cs-3',     e => { e.style.background = secondaryBg || bg; });
  el('bpv-cs-eyebrow', e => { e.style.background = accent; e.style.color = bg; });
  el('bpv-cs-title', e => { e.style.color = text; e.style.fontFamily = headingFF; });
  el('bpv-cs-swipe', e => { e.style.color = text; });
  el('bpv-cs-num',   e => { e.style.color = accent; e.style.fontFamily = headingFF; });
  el('bpv-cs-body',  e => { e.style.color = text; e.style.fontFamily = bodyFF; });
  el('bpv-cs-outro', e => { e.style.color = text; e.style.fontFamily = bodyFF; });
  el('bpv-cs-logo',  e => { e.innerHTML = logoHtml(); });
}

function el(id, fn) {
  const node = document.getElementById(id);
  if (node) fn(node);
}

/* ── Preview tabs ─────────────────────────────────────────────── */
document.querySelectorAll('.brand-ptab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.brand-ptab').forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    const target = tab.dataset.tab;
    ['bpp-quote', 'bpp-branded', 'bpp-carousel'].forEach(id => {
      const panel = document.getElementById(id);
      if (panel) panel.hidden = id !== `bpp-${target}`;
    });
  });
});

/* ── Carousel slide nav ───────────────────────────────────────── */
let _activeSlide = 0;

function setCarouselSlide(idx) {
  _activeSlide = idx;
  document.querySelectorAll('.bpv-carousel-slide').forEach((s, i) => s.classList.toggle('active', i === idx));
  document.querySelectorAll('.bpv-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
}

document.querySelectorAll('.bpv-dot').forEach(dot => {
  dot.addEventListener('click', () => setCarouselSlide(parseInt(dot.dataset.slide, 10)));
});

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

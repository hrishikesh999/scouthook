/* generate.js — all interaction logic for generate.html */

/* ── 1. DOM References ───────────────────────────────────────── */
const ideaFields      = document.getElementById('idea-fields');
const ideaInput       = document.getElementById('idea-input');
const ideaError       = document.getElementById('idea-error');
const generateBtn     = document.getElementById('generate-btn');
const voiceIndicator  = document.getElementById('voice-indicator-area');

const toggleBar       = document.getElementById('toggle-bar');
const tabEdit         = document.getElementById('tab-edit');
const tabPreviewBtn   = document.getElementById('tab-preview');
const wordCountEl     = document.getElementById('word-count');

const scoreBar        = document.getElementById('score-bar');
const scoreNumber     = document.getElementById('score-number');
const forceRetPill    = document.getElementById('force-returned-pill');
const archetypeBadge  = document.getElementById('archetype-badge');
const confidenceText  = document.getElementById('confidence-text');
const passfailPill    = document.getElementById('passfail-pill');
const suggestionsBtn  = document.getElementById('suggestions-toggle');
const suggestionsList = document.getElementById('suggestions-list');

const alternativeStrip   = document.getElementById('alternative-strip');
const alternativePreview = document.getElementById('alternative-preview-text');
const switchAltBtn       = document.getElementById('switch-alternative-btn');

const emptyState      = document.getElementById('empty-state');
const skeletonState   = document.getElementById('skeleton-state');
const postErrorState  = document.getElementById('post-error-state');
const tryAgainLink    = document.getElementById('try-again-link');
const postTextarea    = document.getElementById('post-textarea');
const postEditArea    = document.getElementById('post-edit-area');
const linkedinPreview = document.getElementById('linkedin-preview');
const previewBody     = document.getElementById('preview-body');
const previewName     = document.getElementById('preview-name');
const previewHeadline = document.getElementById('preview-headline');
const previewInitials = document.getElementById('linkedin-avatar-initials');

const actionBar       = document.getElementById('action-bar');
const actionRight     = document.getElementById('action-right');
const regenerateBtn   = document.getElementById('regenerate-btn');
const quoteCardBtn    = document.getElementById('quote-card-btn');
const carouselBtn     = document.getElementById('carousel-btn');
const brandedQuoteBtn = document.getElementById('branded-quote-btn');
const saveDraftBtn    = document.getElementById('save-draft-btn');
const scheduleBtn     = document.getElementById('schedule-btn');
const postPublishState = document.getElementById('post-publish-state');
const publishedLabel  = document.getElementById('published-label');
const actionBarError  = document.getElementById('action-bar-error');

const slideOver       = document.getElementById('slide-over');
const slideOverLabel  = document.getElementById('slide-over-label');
const slideOverClose  = document.getElementById('slide-over-close');
const slideOverContent = document.getElementById('slide-over-content');
const slideOverSkeleton = document.getElementById('slide-over-skeleton');
const slideOverSave   = document.getElementById('slide-over-save');
const slideOverAdd    = document.getElementById('slide-over-add');
const slideOverDiscard = document.getElementById('slide-over-discard');

const mediaDrawer      = document.getElementById('media-drawer');
const mediaDrawerClose = document.getElementById('media-drawer-close');
const drawerUploadZone = document.getElementById('drawer-upload-zone');
const drawerFileInput  = document.getElementById('drawer-file-input');
const drawerGrid       = document.getElementById('drawer-media-grid');
const drawerEmptyMsg   = document.getElementById('drawer-empty-msg');
const drawerErrorMsg   = document.getElementById('drawer-error-msg');
const mediaLibraryBtn  = document.getElementById('media-library-btn');

const assetChip       = document.getElementById('asset-chip');
const assetChipLabel  = document.getElementById('asset-chip-label');
const assetChipRemove = document.getElementById('asset-chip-remove');

const previewAssetEl    = document.getElementById('preview-asset');
const previewAvatarImg  = document.getElementById('linkedin-avatar-img');
const rightPanel        = document.getElementById('right-panel');

const scheduleModal   = document.getElementById('schedule-modal');
const scheduleDateEl  = document.getElementById('schedule-date');
const scheduleTimeEl  = document.getElementById('schedule-time');
const scheduleCancel  = document.getElementById('schedule-cancel');
const scheduleConfirm = document.getElementById('schedule-confirm-btn');
const publishNowBtn   = document.getElementById('publish-now-btn');
const modalError      = document.getElementById('modal-error');

const overlay         = document.getElementById('overlay');

const scheduleLockBanner     = document.getElementById('schedule-lock-banner');
const scheduleLockBannerText = document.getElementById('schedule-lock-banner-text');
const schedulePauseBtn       = document.getElementById('schedule-pause-btn');
const scheduleLockMsg        = document.getElementById('schedule-lock-banner-msg');

/* ── 2. State ────────────────────────────────────────────────── */
let currentPath       = 'idea';
let currentPostId     = null;
let primaryPost       = null;
let alternativePost   = null;
let currentAssetUrl   = null;
let currentAssetType  = null;
/** Asset committed via "Add to post" — included in publish/schedule payloads. */
let attachedAssetUrl  = null;
let attachedAssetType = null;
/** Preview image URL for committed asset (first slide for carousel, png_url for others). */
let attachedPreviewUrl = null;
let attachedSlideCount = 0;
/** In-flight preview URL (populated during generateVisual, before "Add to post"). */
let currentPreviewUrl  = null;
let currentSlideCount  = 0;
let suggestionsExpanded = false;
let previewExpanded   = false;
let undoTimer         = null;
let rescoreDebounce   = null;
let sessionDebounce   = null;
/** When true, post is scheduled — editing must wait until pause (cancel schedule). */
let scheduleEditLocked  = false;
/** @type {{ scheduledFor: string, scheduledPostId: number|null } | null} */
let scheduledMeta       = null;

/* ── Vault Tab B state ───────────────────────────────────────── */
/** ID of the vault_idea currently selected (null = free-type mode). */
let currentVaultIdeaId  = null;
let allVaultSeeds       = [];
let activeSeedFunnel    = '';

// ── Vault Tab DOM refs ────────────────────────────────────────
const inputTabWrite    = document.getElementById('input-tab-write');
const inputTabVault    = document.getElementById('input-tab-vault');
const vaultPanel       = document.getElementById('vault-ideas-panel');
const vaultSeedList    = document.getElementById('vault-seed-list');
const miniFunnelWidget = document.getElementById('mini-funnel-widget');
const vaultSourceBadge = document.getElementById('vault-source-badge');
const seedFilterBtns   = document.querySelectorAll('.seed-filter-btn');

// ── Tab switching ─────────────────────────────────────────────
function switchToTab(tab) {
  if (tab === 'write') {
    inputTabWrite.classList.add('active');    inputTabWrite.setAttribute('aria-selected', 'true');
    inputTabVault.classList.remove('active'); inputTabVault.setAttribute('aria-selected', 'false');
    document.getElementById('idea-fields').style.display = '';
    vaultPanel.style.display = 'none';
    generateBtn.style.display = '';
  } else {
    inputTabVault.classList.add('active');    inputTabVault.setAttribute('aria-selected', 'true');
    inputTabWrite.classList.remove('active'); inputTabWrite.setAttribute('aria-selected', 'false');
    document.getElementById('idea-fields').style.display = 'none';
    vaultPanel.style.display = '';
    generateBtn.style.display = 'none';
    loadVaultSeeds();
    loadMiniFunnel();
  }
}

inputTabWrite.addEventListener('click', () => switchToTab('write'));
inputTabVault.addEventListener('click', () => switchToTab('vault'));

// ── Seed funnel filter ────────────────────────────────────────
seedFilterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    seedFilterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeSeedFunnel = btn.dataset.funnel || '';
    renderSeedList();
  });
});

// ── Load seeds from vault ─────────────────────────────────────
async function loadVaultSeeds() {
  try {
    const res  = await fetch('/api/vault/ideas?status=fresh&status=saved');
    const data = await res.json();
    if (!data.ok) return;
    // Fetch all non-discarded ideas (both fresh and saved)
    const res2  = await fetch('/api/vault/ideas');
    const data2 = await res2.json();
    allVaultSeeds = (data2.ideas || []).filter(i => i.status === 'fresh' || i.status === 'saved');
    renderSeedList();
  } catch { /* non-fatal */ }
}

function renderSeedList() {
  const visible = allVaultSeeds.filter(s => !activeSeedFunnel || s.funnel_type === activeSeedFunnel);
  if (!visible.length) {
    vaultSeedList.innerHTML = `<div class="seed-list-empty">No seeds yet. <a href="/vault.html">Upload documents</a> and click "Generate Ideas".</div>`;
    return;
  }
  vaultSeedList.innerHTML = visible.map(seed => {
    const fBadge = seed.funnel_type
      ? `<span class="seed-badge ${seed.funnel_type}">${seed.funnel_type.toUpperCase()}</span>` : '';
    const aBadge = seed.hook_archetype
      ? `<span class="seed-badge arch">${seed.hook_archetype}</span>` : '';
    return `
      <div class="seed-card" data-seed-id="${seed.id}">
        <div class="seed-card-badges">${fBadge}${aBadge}</div>
        <p class="seed-card-text">${escHtmlG(seed.seed_text)}</p>
        ${seed.source_ref ? `<p class="seed-card-source">${escHtmlG(seed.source_ref)}</p>` : ''}
        <button type="button" class="seed-use-btn" data-use-id="${seed.id}">Generate post</button>
      </div>`;
  }).join('');

  vaultSeedList.querySelectorAll('.seed-use-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id   = Number(btn.dataset.useId);
      const seed = allVaultSeeds.find(s => Number(s.id) === id);
      if (!seed) return;
      useSeedIdea(Number(seed.id), seed.seed_text, seed.source_ref || '');
    });
  });
}

function useSeedIdea(ideaId, seedText, sourceRef) {
  currentVaultIdeaId = ideaId;
  triggerGenerate({ path: 'idea', raw_idea: seedText, vault_idea_id: ideaId });
}

// ── Mini funnel widget ────────────────────────────────────────
async function loadMiniFunnel() {
  try {
    const res  = await fetch('/api/funnel/health');
    const data = await res.json();
    if (!data.ok || data.total === 0) return;
    miniFunnelWidget.style.display = '';
    const pills = ['reach', 'trust', 'convert'].map(t =>
      `<span class="mini-funnel-pill ${t}">${t.toUpperCase()} ${data.counts[t]}</span>`
    ).join('');
    const next = data.nextSuggested;
    miniFunnelWidget.innerHTML = `
      <div class="mini-funnel-row">
        <span class="mini-funnel-label">30d</span>
        <div class="mini-funnel-pills">${pills}</div>
      </div>
      <p class="mini-funnel-next">You need more <strong>${next}</strong> content</p>`;
  } catch { /* non-fatal */ }
}

function escHtmlG(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttrG(str) {
  return String(str).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Handle URL params (from ideas.html "Grow this idea") ─────
// Vault URL params are handled inside init() after auth is ready.

function formatScheduledLocal(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  } catch {
    return '';
  }
}

function getUserTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; }
}

function getUserTzAbbr() {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(new Date())
      .find(p => p.type === 'timeZoneName')?.value || '';
  } catch { return ''; }
}

function applyScheduleLockUi() {
  if (!scheduleLockBanner) return;
  scheduleLockBanner.classList.remove('hidden');
  const when = scheduledMeta?.scheduledFor ? formatScheduledLocal(scheduledMeta.scheduledFor) : '';
  scheduleLockBannerText.textContent = when
    ? `This post is scheduled for ${when}. Pause scheduling to edit — the scheduled send uses a separate copy until you pause.`
    : 'This post is scheduled. Pause scheduling to edit.';
  if (scheduleLockMsg) scheduleLockMsg.textContent = '';
  postTextarea.readOnly = true;
  regenerateBtn.disabled = true;
  generateBtn.disabled = true;
  ideaInput.readOnly = true;
  scheduleBtn.disabled = true;
  quoteCardBtn.classList.add('disabled');
  carouselBtn.classList.add('disabled');
  brandedQuoteBtn.classList.add('disabled');
  mediaLibraryBtn.classList.add('disabled');
  if (assetChipRemove) assetChipRemove.style.display = 'none';
  switchAltBtn.style.pointerEvents = 'none';
  switchAltBtn.style.opacity = '0.5';
}

function clearScheduleLockUi() {
  if (scheduleLockBanner) scheduleLockBanner.classList.add('hidden');
  if (scheduleLockMsg) scheduleLockMsg.textContent = '';
  postTextarea.readOnly = false;
  regenerateBtn.disabled = false;
  generateBtn.disabled = false;
  ideaInput.readOnly = false;
  quoteCardBtn.classList.remove('disabled');
  carouselBtn.classList.remove('disabled');
  brandedQuoteBtn.classList.remove('disabled');
  mediaLibraryBtn.classList.remove('disabled');
  if (assetChipRemove) assetChipRemove.style.display = '';
  switchAltBtn.style.pointerEvents = '';
  switchAltBtn.style.opacity = '';
  postPublishState.classList.remove('visible');
  actionRight.style.display = '';
}

function setScheduleLockFromPost(p) {
  if (p && p.status === 'scheduled' && p.scheduled_for) {
    scheduleEditLocked = true;
    scheduledMeta = {
      scheduledFor: p.scheduled_for,
      scheduledPostId: p.scheduled_post_id,
    };
    applyScheduleLockUi();
    showPublishedState(`Scheduled · ${formatScheduledLocal(p.scheduled_for)}`);
    return;
  }
  const wasLocked = scheduleEditLocked;
  scheduleEditLocked = false;
  scheduledMeta = null;
  if (wasLocked) {
    clearScheduleLockUi();
  }
  if (p && p.status === 'draft') {
    enableActionButtons();
  }
}

async function refetchPostAndApplyLock() {
  if (!currentPostId) return;
  try {
    const res = await fetch(`/api/posts/${encodeURIComponent(currentPostId)}`, { headers: apiHeaders() });
    const data = await res.json();
    if (!data.ok || !data.post) return;
    setScheduleLockFromPost(data.post);
    if (data.post.status === 'published') {
      postTextarea.readOnly = true;
      postTextarea.classList.add('published');
      showPublishedState('Published · LinkedIn');
      Session.clear();
    }
  } catch { /* ignore */ }
}

if (schedulePauseBtn) {
  schedulePauseBtn.addEventListener('click', async () => {
    if (!currentPostId) return;
    schedulePauseBtn.disabled = true;
    if (scheduleLockMsg) scheduleLockMsg.textContent = '';
    try {
      const res = await fetch('/api/linkedin/scheduled/pause-by-post', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ post_id: currentPostId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        if (data.error === 'no_active_schedule') {
          await refetchPostAndApplyLock();
          if (scheduleLockMsg) {
            scheduleLockMsg.textContent = 'Schedule already ended or this post was published — state refreshed.';
          }
          if (window.toast && typeof window.toast.info === 'function') {
            window.toast.info('Schedule already ended — refreshed the post state.');
          }
          return;
        }
        throw new Error(data.error || 'Could not pause');
      }
      await refetchPostAndApplyLock();
      if (window.toast && typeof window.toast.success === 'function') {
        window.toast.success('Scheduling paused. You can edit this post now.');
      }
    } catch (e) {
      if (scheduleLockMsg) scheduleLockMsg.textContent = e.message || 'Could not pause';
      if (window.toast && typeof window.toast.error === 'function') {
        window.toast.error('Couldn’t pause scheduling. Please try again.');
      }
    } finally {
      schedulePauseBtn.disabled = false;
    }
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && scheduleEditLocked && currentPostId) {
    refetchPostAndApplyLock();
  }
});

/* ── 3. Init ─────────────────────────────────────────────────── */
(async function init() {
  await window.scouthookAuthReady;

  // Wire userId into the Connect LinkedIn button href
  const connectBtn = document.getElementById('linkedin-connect-btn');
  if (connectBtn) {
    connectBtn.href = `/api/linkedin/connect?_uid=${encodeURIComponent(getUserId())}&_tid=${encodeURIComponent(getTenantId())}`;
  }

  await checkLinkedInStatus();
  await loadProfile();

  const _qs      = new URLSearchParams(window.location.search);
  const urlPostId = _qs.get('postId');
  const isNew     = _qs.has('new');
  const session   = Session.load();

  // ── Vault seed from ideas page ("Generate post" button) ──────
  // Checked first: if present, skip session restore and auto-generate.
  const vaultSeedText = _qs.get('seed');
  const vaultIdeaId   = _qs.get('vault_idea_id');
  if (vaultSeedText && vaultIdeaId) {
    currentVaultIdeaId = Number(vaultIdeaId);
    ideaInput.value    = decodeURIComponent(vaultSeedText);
    if (vaultSourceBadge) vaultSourceBadge.style.display = 'none';
    window.history.replaceState({}, '', '/generate.html');
    triggerGenerate();
    return;
  }

  if (isNew) {
    // Explicit "new post" navigation — wipe any in-progress session so a blank slate loads
    Session.clear();
  } else if (urlPostId && String(session?.postId) !== String(urlPostId)) {
    // URL points to a specific draft that differs from (or absent in) the session —
    // fetch it from the DB and render it directly.
    try {
      const res  = await fetch(`/api/posts/${encodeURIComponent(urlPostId)}`, { headers: apiHeaders() });
      const data = await res.json();
      if (data.ok && data.post) {
        // Reconstruct quality object from DB integer + flags (renderScoreBar expects an object)
        let qualityObj = null;
        if (data.post.quality_score != null) {
          let flags = [];
          try { flags = JSON.parse(data.post.quality_flags || '[]'); } catch { flags = []; }
          qualityObj = { score: data.post.quality_score, flags, forcedReturn: false };
        }

        currentPostId = data.post.id;
        primaryPost   = {
          post:       data.post.content,
          postId:     data.post.id,
          quality:    qualityObj,
          archetype:  data.post.format_slug,
          confidence: null,
        };
        if (data.post.idea_input) ideaInput.value = data.post.idea_input;
        renderPost(data.post.content);
        updateWordCount(data.post.content);
        renderScoreBar(qualityObj, data.post.format_slug, null);
        setScheduleLockFromPost(data.post);
      }
    } catch { /* fall through to session restore on network error */ }
  } else if (session) {
    restoreSession(session);
  }
})();

/* ── 4. LinkedIn status ──────────────────────────────────────── */
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
  try {
    const res = await fetch('/api/linkedin/status', { headers: apiHeaders() });
    const data = await res.json();
    const area = document.getElementById('nav-linkedin-area');
    if (data.connected) {
      area.innerHTML = buildLinkedInChip(data.name, data.photo_url);
      // Populate LinkedIn preview header
      if (data.name) previewName.textContent = data.name;
      if (data.photo_url) {
        previewAvatarImg.src = data.photo_url;
        previewAvatarImg.style.display = '';
        previewInitials.style.display = 'none';
      } else if (data.name) {
        previewInitials.textContent = data.name.charAt(0).toUpperCase();
      }
    }
  } catch {
    // Leave default connect button
  }
}

/* ── 5. Profile check ────────────────────────────────────────── */
async function loadProfile() {
  try {
    const uid = getUserId();
    const res = await fetch(`/api/profile/${uid}`, { headers: apiHeaders() });
    const data = await res.json();
    const profile = data.profile;

    const complete = profile && profile.content_niche && profile.audience_role && profile.audience_pain;
    if (complete) {
      voiceIndicator.innerHTML = `<div class="voice-indicator"><span class="voice-indicator-dot voice-indicator-dot--green"></span><a href="/profile.html" class="edit-link">Created using your voice profile</a></div>`;
      if (profile.audience_role) previewHeadline.textContent = profile.audience_role;
    } else {
      voiceIndicator.innerHTML = `<div class="voice-indicator"><span class="voice-indicator-dot voice-indicator-dot--red"></span><a href="/profile.html" class="edit-link">Voice profile incomplete — complete it for better results</a></div>`;
    }
  } catch {
    voiceIndicator.innerHTML = `<div class="voice-indicator"><span class="voice-indicator-dot voice-indicator-dot--red"></span><a href="/profile.html" class="edit-link">Voice profile incomplete — complete it for better results</a></div>`;
  }
}

/* ── 6. Field errors ─────────────────────────────────────────── */
function clearFieldErrors() {
  ideaInput.classList.remove('error');
  ideaError.classList.remove('visible');
}

/* ── 8. Generate button ──────────────────────────────────────── */
generateBtn.addEventListener('click', () => triggerGenerate());

async function triggerGenerate(retryData) {
  if (scheduleEditLocked) return;
  clearFieldErrors();

  let body;

  if (retryData) {
    body = retryData;
  } else {
    const idea = ideaInput.value.trim();
    if (!idea) {
      ideaInput.classList.add('error');
      ideaError.classList.add('visible');
      ideaInput.focus();
      return;
    }
    body = { path: 'idea', raw_idea: idea };
    // Attach vault idea context if the idea came from the Vault tab
    if (currentVaultIdeaId) {
      body.vault_idea_id = currentVaultIdeaId;
    }
  }

  setGenerating(true);
  showSkeleton();

  // Store for retry
  const lastBody = body;
  tryAgainLink.onclick = (e) => {
    e.preventDefault();
    triggerGenerate(lastBody);
  };

  // Set a 30-second timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Generation failed');
    }

    handleGenerateSuccess(data, currentPath);

    // Show source badge if post came from vault idea
    if (data.vault_source_ref && vaultSourceBadge) {
      vaultSourceBadge.textContent = data.vault_source_ref;
      vaultSourceBadge.style.display = '';
    } else if (vaultSourceBadge) {
      vaultSourceBadge.style.display = 'none';
    }
    // Reset vault idea ID after use so next generation is a fresh slate
    currentVaultIdeaId = null;

  } catch (err) {
    if (err.message === 'complete_profile_first') {
      showProfileIncompleteError();
    } else {
      showPostError();
    }
  } finally {
    setGenerating(false);
  }
}

/* ── 9. Handle generation success ───────────────────────────── */
function handleGenerateSuccess(data, path) {
  let post, postId, quality, archetype, confidence, alternative;

  if (path === 'recipe') {
    const first = data.posts && data.posts[0];
    if (!first) { showPostError(); return; }
    post        = first.content || first.post;
    postId      = first.id;
    quality     = first.quality;
    archetype   = null;
    confidence  = null;
    alternative = null;
  } else {
    post        = data.post;
    postId      = data.id;
    quality     = data.quality;
    archetype   = data.archetypeUsed;
    confidence  = data.hookConfidence;
    alternative = data.alternative;
  }

  primaryPost     = { post, postId, quality, archetype, confidence };
  alternativePost = alternative || null;
  currentPostId   = postId;

  scheduleEditLocked = false;
  scheduledMeta = null;

  renderPost(post);
  renderScoreBar(quality, archetype, confidence);
  renderAlternativeStrip(alternative, confidence);
  enableActionButtons();
  updateWordCount(post);

  // Scroll right panel into view on mobile
  if (window.innerWidth <= 768) {
    document.getElementById('right-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const session = buildSession();
  Session.save(session);
}

function buildSession() {
  return {
    path: currentPath,
    ideaInput: ideaInput.value,
    post:        postTextarea.value,
    postId:      currentPostId,
    primary:     primaryPost,
    alternative: alternativePost,
    attachedAssetUrl:   attachedAssetUrl,
    attachedAssetType:  attachedAssetType,
    attachedPreviewUrl: attachedPreviewUrl,
    attachedSlideCount: attachedSlideCount,
  };
}

/* ── 10. Render post ─────────────────────────────────────────── */
function renderPost(text) {
  hideSkeleton();
  emptyState.classList.add('hidden');
  postErrorState.classList.remove('visible');
  postTextarea.value = text;
  postTextarea.classList.add('visible');
  postTextarea.classList.remove('published');
  autoGrowTextarea(postTextarea);
}

/* ── 11. Score bar ───────────────────────────────────────────── */
function renderScoreBar(quality, archetype, confidence) {
  if (!quality) return;

  scoreBar.classList.add('visible');

  animateScore(quality.score || 0);

  // Colour class
  const score = quality.score || 0;
  scoreNumber.className = '';
  if (score >= 75)      scoreNumber.classList.add('pass');
  else if (score >= 50) scoreNumber.classList.add('borderline');
  else                  scoreNumber.classList.add('fail');

  // Force returned
  forceRetPill.style.display = quality.forcedReturn ? '' : 'none';

  // Archetype badge
  if (archetype) {
    archetypeBadge.textContent = archetype.toUpperCase();
    archetypeBadge.style.display = '';
  } else {
    archetypeBadge.style.display = 'none';
  }

  // Confidence
  if (confidence !== null && confidence !== undefined) {
    confidenceText.textContent = `${Math.round(confidence * 100)}% confident`;
    confidenceText.style.display = '';
  } else {
    confidenceText.style.display = 'none';
  }

  // Pass / fail pill
  const passed = quality.passed || quality.passed_gate;
  passfailPill.textContent = passed ? '● Passed' : '● Failed';
  passfailPill.className = 'passfail-pill ' + (passed ? 'pass' : 'fail');

  // Suggestions
  const allItems = [...(quality.errors || []), ...(quality.warnings || [])];
  if (allItems.length > 0) {
    suggestionsBtn.classList.add('visible');
    updateSuggestionsBtn(allItems.length);
    renderSuggestions(quality.errors || [], quality.warnings || []);
  } else {
    suggestionsBtn.classList.remove('visible');
    suggestionsList.classList.remove('visible');
    suggestionsExpanded = false;
  }
}

function animateScore(target) {
  const start    = performance.now();
  const duration = 600;
  function step(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased    = 1 - Math.pow(1 - progress, 3);
    scoreNumber.textContent = Math.round(eased * target);
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function updateSuggestionsBtn(count) {
  suggestionsBtn.textContent = suggestionsExpanded
    ? `▾ ${count} suggestions`
    : `▸ ${count} suggestions to review`;
  suggestionsBtn.setAttribute('aria-expanded', String(suggestionsExpanded));
}

function renderSuggestions(errors, warnings) {
  const items = [
    ...errors.map(e => ({ text: e, type: 'error' })),
    ...warnings.map(w => ({ text: w, type: 'warning' }))
  ];
  suggestionsList.innerHTML = items.map(item =>
    `<div class="suggestion-item" role="listitem">${item.type === 'error' ? '⚠ ' : '· '}${escHtml(item.text)}</div>`
  ).join('');
}

suggestionsBtn.addEventListener('click', () => {
  suggestionsExpanded = !suggestionsExpanded;
  const allItems = [...scoreBar.querySelectorAll('.suggestion-item')];
  const count = allItems.length;
  updateSuggestionsBtn(count);
  suggestionsList.classList.toggle('visible', suggestionsExpanded);
});

/* ── 12. Alternative strip ───────────────────────────────────── */
function renderAlternativeStrip(alternative, confidence) {
  if (!alternative || confidence === null || confidence >= 0.7) {
    alternativeStrip.classList.remove('visible');
    return;
  }
  const words = (alternative.post || '').split(/\s+/).slice(0, 8).join(' ');
  alternativePreview.textContent = `We also wrote an INSIGHT version — "${words}… " `;
  alternativeStrip.classList.add('visible');
}

switchAltBtn.addEventListener('click', (e) => {
  e.preventDefault();
  if (scheduleEditLocked) return;
  if (!alternativePost) return;

  const prev = primaryPost;
  primaryPost = { post: alternativePost.post, postId: alternativePost.id, quality: alternativePost.quality, archetype: alternativePost.archetypeUsed, confidence: null };
  alternativePost = prev;

  renderPost(primaryPost.post);
  renderScoreBar(primaryPost.quality, primaryPost.archetype, primaryPost.confidence);
  alternativeStrip.classList.remove('visible');
  currentPostId = primaryPost.postId;

  Session.save(buildSession());
});

/* ── 13. Edit / Preview tabs ─────────────────────────────────── */
tabEdit.addEventListener('click', () => switchView('edit'));
tabPreviewBtn.addEventListener('click', () => switchView('preview'));

function switchView(view) {
  if (view === 'edit') {
    tabEdit.classList.add('active');
    tabEdit.setAttribute('aria-selected', 'true');
    tabPreviewBtn.classList.remove('active');
    tabPreviewBtn.setAttribute('aria-selected', 'false');
    rightPanel.classList.remove('preview-mode');
    linkedinPreview.classList.remove('visible');
    linkedinPreview.setAttribute('aria-hidden', 'true');
    postTextarea.style.display = postTextarea.classList.contains('visible') ? '' : 'none';
    wordCountEl.style.display = '';
  } else {
    tabPreviewBtn.classList.add('active');
    tabPreviewBtn.setAttribute('aria-selected', 'true');
    tabEdit.classList.remove('active');
    tabEdit.setAttribute('aria-selected', 'false');
    rightPanel.classList.add('preview-mode');
    buildLinkedInPreview(postTextarea.value);
    renderPreviewAsset();
    linkedinPreview.classList.add('visible');
    linkedinPreview.setAttribute('aria-hidden', 'false');
    wordCountEl.style.display = 'none';
  }
}

function buildLinkedInPreview(text) {
  const truncLimit = 210;
  previewExpanded = false;

  if (text.length > truncLimit) {
    const truncated = escHtml(text.slice(0, truncLimit));
    previewBody.innerHTML = truncated + `… <a class="linkedin-see-more" id="see-more-link" href="#" role="button">see more</a>`;
    document.getElementById('see-more-link').addEventListener('click', (e) => {
      e.preventDefault();
      previewExpanded = true;
      previewBody.textContent = text;
    });
  } else {
    previewBody.textContent = text;
  }
}

/* ── 14. Word count ──────────────────────────────────────────── */
function updateWordCount(text) {
  const count = text.trim() ? text.trim().split(/\s+/).length : 0;
  wordCountEl.textContent = `${count} word${count !== 1 ? 's' : ''}`;
}

/* ── 15. Post textarea auto-grow + re-score ──────────────────── */
postTextarea.addEventListener('input', () => {
  if (scheduleEditLocked) return;
  autoGrowTextarea(postTextarea);
  updateWordCount(postTextarea.value);

  // Debounced session + DB auto-save
  clearTimeout(sessionDebounce);
  sessionDebounce = setTimeout(async () => {
    if (!currentPostId || scheduleEditLocked) return;
    Session.save(buildSession());
    showAutosaveState('saving');
    try {
      await fetch(`/api/posts/${currentPostId}`, {
        method:  'PATCH',
        headers: apiHeaders(),
        body:    JSON.stringify({
          content:    postTextarea.value.trim(),
          idea_input: ideaInput.value.trim() || null,
        }),
      });
      showAutosaveState('saved');
    } catch {
      showAutosaveState('hidden');
    }
  }, 1200);

  // Debounced re-score
  clearTimeout(rescoreDebounce);
  rescoreDebounce = setTimeout(() => {
    if (!scheduleEditLocked) rescorePost(postTextarea.value);
  }, 1200);
});

function autoGrowTextarea(el) {
  const surface  = document.getElementById('post-surface');
  const savedTop = surface ? surface.scrollTop : 0;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
  if (surface) surface.scrollTop = savedTop;
}

async function rescorePost(text) {
  if (!text.trim()) return;
  try {
    const res = await fetch('/api/generate/quality-check', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ postText: text })
    });
    const data = await res.json();
    if (data.ok && data.quality) {
      const arch = primaryPost ? primaryPost.archetype : null;
      const conf = primaryPost ? primaryPost.confidence : null;
      renderScoreBar(data.quality, arch, conf);
    }
  } catch {
    // Silently fail
  }
}

/* ── 16. Regenerate ──────────────────────────────────────────── */
regenerateBtn.addEventListener('click', async () => {
  if (scheduleEditLocked) return;
  if (!currentPostId) {
    triggerGenerate();
    return;
  }

  // Store current post for undo
  const prevPost    = postTextarea.value;
  const prevPrimary = primaryPost ? { ...primaryPost } : null;

  regenerateBtn.textContent = 'Undo →';
  regenerateBtn.classList.add('undo-mode');
  regenerateBtn.setAttribute('aria-label', 'Undo regeneration');

  clearTimeout(undoTimer);

  const undoFn = () => {
    if (prevPrimary) {
      renderPost(prevPost);
      renderScoreBar(prevPrimary.quality, prevPrimary.archetype, prevPrimary.confidence);
      primaryPost = prevPrimary;
      currentPostId = prevPrimary.postId;
    }
    resetRegenerateBtn();
  };

  regenerateBtn.onclick = (e) => {
    e.preventDefault();
    clearTimeout(undoTimer);
    undoFn();
    regenerateBtn.onclick = null;
    regenerateBtn.addEventListener('click', () => { if (!currentPostId) triggerGenerate(); });
  };

  undoTimer = setTimeout(() => {
    regenerateBtn.style.opacity = '0';
    setTimeout(() => {
      resetRegenerateBtn();
      regenerateBtn.style.opacity = '';
    }, 1000);
  }, 10000);

  setGenerating(true);
  showSkeleton();

  try {
    const res = await fetch(`/api/generate/regenerate/${currentPostId}`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error();

    const p = data.post;
    const newPost  = p.content || p.post;
    const newQual  = p.quality;
    const newArch  = p.archetypeUsed || null;
    const newConf  = p.hookConfidence !== undefined ? p.hookConfidence : null;

    primaryPost = { post: newPost, postId: p.id, quality: newQual, archetype: newArch, confidence: newConf };
    currentPostId = p.id;

    renderPost(newPost);
    renderScoreBar(newQual, newArch, newConf);
    updateWordCount(newPost);
    Session.save(buildSession());

  } catch {
    showPostError();
  } finally {
    setGenerating(false);
  }
});

function resetRegenerateBtn() {
  regenerateBtn.textContent = 'Regenerate';
  regenerateBtn.classList.remove('undo-mode');
  regenerateBtn.setAttribute('aria-label', 'Regenerate post');
  regenerateBtn.onclick = null;
}

/* ── 17. Save draft ──────────────────────────────────────────── */
/* ── Auto-save indicator ────────────────────────────────────── */
let _autosaveIndicatorTimer = null;
function showAutosaveState(state) {
  clearTimeout(_autosaveIndicatorTimer);
  if (state === 'saving') {
    saveDraftBtn.textContent = 'Saving…';
    saveDraftBtn.classList.add('autosave-indicator--saving');
    saveDraftBtn.classList.remove('autosave-indicator--saved');
  } else if (state === 'saved') {
    saveDraftBtn.textContent = 'Saved ✓';
    saveDraftBtn.classList.remove('autosave-indicator--saving');
    saveDraftBtn.classList.add('autosave-indicator--saved');
    _autosaveIndicatorTimer = setTimeout(() => {
      saveDraftBtn.textContent = '';
      saveDraftBtn.classList.remove('autosave-indicator--saved');
    }, 2500);
  } else {
    saveDraftBtn.textContent = '';
    saveDraftBtn.classList.remove('autosave-indicator--saving', 'autosave-indicator--saved');
  }
}

/* ── 18. Schedule modal ──────────────────────────────────────── */
scheduleBtn.addEventListener('click', () => openModal());

scheduleCancel.addEventListener('click', () => closeModal());
overlay.addEventListener('click', () => {
  if (scheduleModal.classList.contains('visible')) closeModal();
  if (slideOver.classList.contains('open')) closeSlideOver();
});

function openModal() {
  if (scheduleEditLocked) return;
  scheduleModal.classList.add('visible');
  scheduleModal.setAttribute('aria-hidden', 'false');
  overlay.classList.add('visible');
  overlay.setAttribute('aria-hidden', 'false');
  modalError.classList.remove('visible');
  scheduleDateEl.value = '';
  scheduleTimeEl.value = '';
  clearPresetSelection();
  const tzLabel = document.getElementById('schedule-tz-label');
  if (tzLabel) {
    const tz = getUserTimezone();
    const abbr = getUserTzAbbr();
    tzLabel.textContent = tz ? `Times shown in your local timezone: ${abbr} (${tz})` : '';
  }
  const firstEl = scheduleModal.querySelector('button.schedule-preset-btn');
  if (firstEl) firstEl.focus();
  trapFocus(scheduleModal);
}

/* ── Schedule presets ─────────────────────────────────────────── */
function calcPreset(key) {
  const now = new Date();
  let d;
  if (key === '2h') {
    d = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    // round up to next 15-min slot
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  } else if (key === 'tomorrow-9') {
    d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
  } else if (key === 'tomorrow-12') {
    d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0);
  } else if (key === 'monday-9') {
    d = new Date(now);
    const daysUntilMonday = (8 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + daysUntilMonday); d.setHours(9, 0, 0, 0);
  }
  return d;
}

function applyPreset(key) {
  const d = calcPreset(key);
  if (!d) return;
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  const hh   = String(d.getHours()).padStart(2, '0');
  const min  = String(d.getMinutes()).padStart(2, '0');
  scheduleDateEl.value = `${yyyy}-${mm}-${dd}`;
  scheduleTimeEl.value = `${hh}:${min}`;
  modalError.classList.remove('visible');
}

function clearPresetSelection() {
  document.querySelectorAll('.schedule-preset-btn').forEach(b => b.classList.remove('active'));
}

document.querySelectorAll('.schedule-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    clearPresetSelection();
    btn.classList.add('active');
    applyPreset(btn.dataset.preset);
  });
});

// Deselect preset if user manually edits date/time
[scheduleDateEl, scheduleTimeEl].forEach(el => {
  el.addEventListener('input', clearPresetSelection);
});

function closeModal() {
  scheduleModal.classList.remove('visible');
  scheduleModal.setAttribute('aria-hidden', 'true');
  overlay.classList.remove('visible');
  overlay.setAttribute('aria-hidden', 'true');
  publishNowBtn.textContent = 'Publish now';
  publishNowBtn.disabled = false;
}

scheduleConfirm.addEventListener('click', async () => {
  const dateVal = scheduleDateEl.value;
  const timeVal = scheduleTimeEl.value;
  if (!dateVal || !timeVal) {
    modalError.textContent = 'Please select a date and time.';
    modalError.classList.add('visible');
    return;
  }
  const scheduledFor = new Date(`${dateVal}T${timeVal}`).toISOString();
  const content = postTextarea.value;

  scheduleConfirm.textContent = 'Scheduling…';
  scheduleConfirm.disabled = true;
  modalError.classList.remove('visible');

  try {
    const schedulePayload = {
      content,
      scheduled_for: scheduledFor,
      ...(currentPostId ? { post_id: currentPostId } : {}),
    };
    if (attachedAssetUrl) {
      if (attachedAssetType === 'carousel' || attachedAssetType === 'media_pdf') {
        schedulePayload.carousel_pdf_url = attachedAssetUrl;
      } else {
        schedulePayload.image_url = attachedAssetUrl;
      }
    }
    const res = await fetch('/api/linkedin/schedule', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify(schedulePayload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      if (data.error === 'scheduling_unavailable') {
        throw new Error('Scheduling is temporarily unavailable. Please try again in a few minutes.');
      }
      if (data.error === 'scheduled_for_too_soon') {
        throw new Error('Please schedule at least 5 minutes from now.');
      }
      if (data.error === 'scheduled_for_too_far') {
        throw new Error('Please pick a time within the next 30 days.');
      }
      if (data.error === 'too_many_scheduled') {
        throw new Error('You have too many posts scheduled already. Publish/cancel one before adding more.');
      }
      if (data.error === 'scheduled_too_close') {
        throw new Error('Please space scheduled posts at least 60 minutes apart.');
      }
      if (data.error === 'content_too_long') {
        throw new Error('Your post is too long for LinkedIn. Please keep it under 3000 characters.');
      }
      throw new Error(data.error || 'Scheduling failed');
    }

    closeModal();
    const dateStr = new Date(`${dateVal}T${timeVal}`).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
    scheduleEditLocked = true;
    scheduledMeta = {
      scheduledFor: scheduledFor,
      scheduledPostId: data.scheduled_post_id != null ? Number(data.scheduled_post_id) : null,
    };
    applyScheduleLockUi();
    showPublishedState(`Scheduled · ${dateStr}`);
    if (window.toast && typeof window.toast.success === 'function') {
      window.toast.success('Post scheduled successfully.');
    }
  } catch (err) {
    modalError.textContent = err.message || 'Something went wrong. Try again.';
    modalError.classList.add('visible');
    if (window.toast && typeof window.toast.error === 'function') {
      window.toast.error('Couldn’t schedule post. Please check the date/time and try again.');
    }
  } finally {
    scheduleConfirm.textContent = 'Schedule';
    scheduleConfirm.disabled = false;
  }
});

// Escape key closes modal/slide-over
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (scheduleModal.classList.contains('visible')) closeModal();
    else if (slideOver.classList.contains('open')) closeSlideOver();
  }
});

function trapFocus(container) {
  const focusable = container.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];

  function handler(e) {
    if (e.key !== 'Tab') return;
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  container.addEventListener('keydown', handler);
  container._trapHandler = handler;
}

/* ── 19. Publish now (inside modal) ─────────────────────────── */
publishNowBtn.addEventListener('click', async () => {
  if (scheduleEditLocked) return;
  const content = postTextarea.value.trim();
  if (!content) return;

  publishNowBtn.textContent = 'Publishing…';
  publishNowBtn.disabled = true;
  modalError.classList.remove('visible');

  try {
    const publishPayload = { content, postId: currentPostId };
    if (attachedAssetUrl) {
      if (attachedAssetType === 'carousel' || attachedAssetType === 'media_pdf') {
        publishPayload.carousel_pdf_url = attachedAssetUrl;
      } else {
        publishPayload.image_url = attachedAssetUrl;
      }
    }
    const res = await fetch('/api/linkedin/publish', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(publishPayload)
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      if (data.error === 'publish_blocked_scheduled') {
        throw new Error('Pause scheduling before publishing, or wait for the scheduled send.');
      }
      throw new Error(data.error || 'Publish failed');
    }

    closeModal();
    attachedAssetUrl   = null;
    attachedAssetType  = null;
    attachedPreviewUrl = null;
    attachedSlideCount = 0;
    assetChip.classList.add('hidden');
    clearPreviewAsset();
    sessionStorage.setItem('sh_just_published', '1');
    postTextarea.classList.add('published');
    showPublishedState('Published · just now');
    Session.clear();
    if (window.toast && typeof window.toast.success === 'function') {
      window.toast.success('Post published successfully.');
    }

  } catch (err) {
    publishNowBtn.textContent = 'Publish now';
    publishNowBtn.disabled = false;
    modalError.textContent = err.message || 'Publish failed. Please try again.';
    modalError.classList.add('visible');
    if (window.toast && typeof window.toast.error === 'function') {
      window.toast.error('Couldn’t publish post. Please try again.');
    }
  }
});

function showPublishedState(label) {
  publishedLabel.textContent = label;
  actionRight.style.display = 'none';
  postPublishState.classList.add('visible');
}


/* ── 21. Slide-over ──────────────────────────────────────────── */
quoteCardBtn.addEventListener('click',   () => openSlideOver('quote_card',     'QUOTE CARD'));
carouselBtn.addEventListener('click',    () => openSlideOver('carousel',        'CAROUSEL'));
brandedQuoteBtn.addEventListener('click',() => openSlideOver('branded_quote',   'BRANDED QUOTE'));

slideOverClose.addEventListener('click',   closeSlideOver);
slideOverDiscard.addEventListener('click', closeSlideOver);

function openSlideOver(type, label) {
  if (scheduleEditLocked) return;
  if (!currentPostId) return;

  currentAssetType = type;
  currentAssetUrl  = null;

  slideOverLabel.textContent  = label;
  slideOverContent.innerHTML  = '';
  slideOverSkeleton.style.display = '';
  slideOverContent.appendChild(slideOverSkeleton);

  slideOver.classList.add('open');
  slideOver.setAttribute('aria-hidden', 'false');
  overlay.classList.add('visible');
  overlay.setAttribute('aria-hidden', 'false');
  slideOverClose.focus();
  trapFocus(slideOver);

  generateVisual(type);
}

function closeSlideOver() {
  slideOver.classList.remove('open');
  slideOver.setAttribute('aria-hidden', 'true');
  overlay.classList.remove('visible');
  overlay.setAttribute('aria-hidden', 'true');
}

function visualErrorMessage(code) {
  if (!code) return 'Failed to generate visual';
  if (code === 'branded_quote_requires_linkedin') {
    return 'Connect LinkedIn in the sidebar to use branded quotes.';
  }
  if (code === 'branded_quote_photo_fetch_failed') {
    return 'Could not load your LinkedIn photo. Try reconnecting LinkedIn.';
  }
  if (code === 'post_not_found' || code === 'forbidden') {
    return 'Post not found or access denied. Refresh the page and try again.';
  }
  return String(code);
}

async function generateVisual(type) {
  try {
    const res = await fetch(`/api/visuals/${encodeURIComponent(String(currentPostId))}`, {
      method: 'POST',
      headers: apiHeaders(),
      credentials: 'include',
      body: JSON.stringify({ visual_type: type }),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('Could not read server response.');
    }
    slideOverSkeleton.style.display = 'none';

    if (!res.ok || !data.ok) {
      throw new Error(visualErrorMessage(data.error));
    }

    if (type === 'carousel') {
      renderCarousel(data.slides);
      currentAssetUrl    = data.pdf_url || data.zip_url;
      currentPreviewUrl  = data.slides?.[0]?.png_url || null;
      currentSlideCount  = data.slides?.length || 0;
    } else {
      currentAssetUrl   = data.png_url;
      currentPreviewUrl = data.png_url;
      currentSlideCount = 0;
      const img = document.createElement('img');
      img.src = data.png_url;
      img.alt = '';
      img.className = 'slide-over-image';
      slideOverContent.appendChild(img);
    }
  } catch (e) {
    slideOverSkeleton.style.display = 'none';
    const err = document.createElement('p');
    err.style.cssText = 'font-size:14px;color:var(--text-secondary);text-align:center;padding-top:var(--space-8)';
    err.textContent =
      e instanceof Error && e.message ? e.message : 'Could not generate asset. Try again.';
    slideOverContent.appendChild(err);
  }
}

function renderCarousel(slides) {
  if (!slides || !slides.length) return;
  slides.forEach((slide, i) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'carousel-slide';
    const label = document.createElement('div');
    label.className = 'carousel-slide-label';
    label.textContent = `Slide ${i + 1}`;
    const img = document.createElement('img');
    img.src = slide.png_url;
    img.alt = '';
    img.className = 'slide-over-image';
    wrapper.appendChild(label);
    wrapper.appendChild(img);
    slideOverContent.appendChild(wrapper);
  });
}

slideOverSave.addEventListener('click', () => {
  if (!currentAssetUrl) return;
  const a = document.createElement('a');
  a.href = currentAssetUrl;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

slideOverAdd.addEventListener('click', () => {
  if (currentAssetUrl) {
    attachedAssetUrl   = currentAssetUrl;
    attachedAssetType  = currentAssetType;
    attachedPreviewUrl = currentPreviewUrl;
    attachedSlideCount = currentSlideCount;
    const labelMap = { quote_card: 'Quote Card', carousel: 'Carousel', branded_quote: 'Branded Quote' };
    assetChipLabel.textContent = labelMap[attachedAssetType] || attachedAssetType;
    assetChip.classList.remove('hidden');
    renderPreviewAsset();
    // Persist to media library in the background — updates attachedAssetUrl/attachedPreviewUrl
    // with permanent /uploads/ URLs once saved
    saveGeneratedToMedia(currentAssetUrl, currentAssetType, currentPreviewUrl);
  }
  closeSlideOver();
});

assetChipRemove.addEventListener('click', () => {
  attachedAssetUrl   = null;
  attachedAssetType  = null;
  attachedPreviewUrl = null;
  attachedSlideCount = 0;
  assetChip.classList.add('hidden');
  assetChipLabel.textContent = '';
  clearPreviewAsset();
});

function renderPreviewAsset() {
  if (!attachedPreviewUrl || !previewAssetEl) return;
  previewAssetEl.innerHTML = '';
  const img = document.createElement('img');
  img.src = attachedPreviewUrl;
  img.alt = attachedAssetType === 'carousel' ? 'Carousel preview' : 'Visual asset';
  previewAssetEl.appendChild(img);
  if (attachedAssetType === 'carousel' && attachedSlideCount > 1) {
    const badge = document.createElement('div');
    badge.className = 'preview-asset-badge';
    badge.textContent = `Document \u00b7 ${attachedSlideCount} slides`;
    previewAssetEl.appendChild(badge);
  }
  previewAssetEl.classList.remove('hidden');
  previewAssetEl.setAttribute('aria-hidden', 'false');
}

function clearPreviewAsset() {
  if (!previewAssetEl) return;
  previewAssetEl.innerHTML = '';
  previewAssetEl.classList.add('hidden');
  previewAssetEl.setAttribute('aria-hidden', 'true');
}

/* ── Save generated visual to media library ─────────────────── */
async function saveGeneratedToMedia(assetUrl, assetType, previewUrl) {
  if (!assetUrl || !assetUrl.startsWith('/files/')) return;

  // Determine what to save and with what metadata
  const saves = [];

  if (assetType === 'carousel') {
    saves.push({
      fileUrl:  assetUrl,
      filename: `carousel_${Date.now()}.pdf`,
      mimeType: 'application/pdf',
      role:     'asset',   // updates attachedAssetUrl
    });
  } else {
    // quote_card or branded_quote — save the PNG
    const prefix = assetType === 'branded_quote' ? 'branded_quote' : 'quote_card';
    saves.push({
      fileUrl:  assetUrl,
      filename: `${prefix}_${Date.now()}.png`,
      mimeType: 'image/png',
      role:     'asset',   // updates both attachedAssetUrl and attachedPreviewUrl
    });
  }

  for (const save of saves) {
    try {
      const res  = await fetch('/api/media/save-generated', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify({ fileUrl: save.fileUrl, filename: save.filename, mimeType: save.mimeType }),
      });
      const data = await res.json();
      if (!data.ok) continue;

      // Upgrade temporary /files/ URLs to permanent /uploads/ URLs
      if (save.role === 'asset') {
        attachedAssetUrl = data.file.url;
        if (assetType !== 'carousel') attachedPreviewUrl = data.file.url;
      }

      // Persist session with updated permanent URLs
      if (currentPostId) Session.save(buildSession());
    } catch { /* non-fatal — temporary URL still works for 24 h */ }
  }
}

/* ── 22. Enable / disable action buttons ────────────────────── */
function enableActionButtons() {
  if (scheduleEditLocked) {
    scheduleBtn.disabled = true;
    quoteCardBtn.classList.add('disabled');
    carouselBtn.classList.add('disabled');
    brandedQuoteBtn.classList.add('disabled');
    mediaLibraryBtn.classList.add('disabled');
    return;
  }
  scheduleBtn.disabled  = false;
  quoteCardBtn.classList.remove('disabled');
  carouselBtn.classList.remove('disabled');
  brandedQuoteBtn.classList.remove('disabled');
  mediaLibraryBtn.classList.remove('disabled');
}

function disableActionButtons() {
  showAutosaveState('hidden');
  scheduleBtn.disabled  = true;
  quoteCardBtn.classList.add('disabled');
  carouselBtn.classList.add('disabled');
  brandedQuoteBtn.classList.add('disabled');
  mediaLibraryBtn.classList.add('disabled');
}

/* ── 23. Loading states ──────────────────────────────────────── */
function setGenerating(loading) {
  generateBtn.disabled    = loading;
  generateBtn.textContent = loading ? 'Generating…' : 'Generate';
}

function showSkeleton() {
  emptyState.classList.add('hidden');
  postTextarea.classList.remove('visible');
  postErrorState.classList.remove('visible');
  skeletonState.classList.add('visible');
}

function hideSkeleton() {
  skeletonState.classList.remove('visible');
}

function showPostError() {
  hideSkeleton();
  emptyState.classList.add('hidden');
  postTextarea.classList.remove('visible');
  postErrorState.classList.add('visible');
}

function showProfileIncompleteError() {
  hideSkeleton();
  emptyState.classList.add('hidden');
  postTextarea.classList.remove('visible');
  postErrorState.innerHTML = `Your voice profile is incomplete — posts need it to generate. <a href="/profile.html">Complete it →</a>`;
  postErrorState.classList.add('visible');
}

/* ── 24. Session restore ─────────────────────────────────────── */
function restoreSession(s) {
  if (!s || !s.post) return;

  // Restore inputs
  if (s.ideaInput) ideaInput.value = s.ideaInput;

  // Restore post
  currentPostId   = s.postId || null;
  primaryPost     = s.primary || null;
  alternativePost = s.alternative || null;

  renderPost(s.post);
  updateWordCount(s.post);

  if (primaryPost) {
    renderScoreBar(primaryPost.quality, primaryPost.archetype, primaryPost.confidence);
    renderAlternativeStrip(alternativePost, primaryPost.confidence);
  }

  enableActionButtons();

  // Restore attached visual asset
  if (s.attachedAssetUrl) {
    attachedAssetUrl   = s.attachedAssetUrl;
    attachedAssetType  = s.attachedAssetType  || null;
    attachedPreviewUrl = s.attachedPreviewUrl || null;
    attachedSlideCount = s.attachedSlideCount || 0;
    const labelMap = { quote_card: 'Quote Card', carousel: 'Carousel', branded_quote: 'Branded Quote' };
    assetChipLabel.textContent = labelMap[attachedAssetType] || attachedAssetType;
    assetChip.classList.remove('hidden');
  }

  if (currentPostId) {
    refetchPostAndApplyLock();
  }
}

/* ── 26. Media drawer ────────────────────────────────────────── */
mediaLibraryBtn.addEventListener('click', () => {
  if (scheduleEditLocked || !currentPostId) return;
  openMediaDrawer();
});

mediaDrawerClose.addEventListener('click', closeMediaDrawer);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mediaDrawer.classList.contains('open')) closeMediaDrawer();
});

overlay.addEventListener('click', () => {
  if (mediaDrawer.classList.contains('open')) closeMediaDrawer();
});

function openMediaDrawer() {
  // Close visual slide-over if open
  if (slideOver.classList.contains('open')) closeSlideOver();

  mediaDrawer.classList.add('open');
  mediaDrawer.setAttribute('aria-hidden', 'false');
  overlay.classList.add('visible');
  overlay.setAttribute('aria-hidden', 'false');
  mediaDrawerClose.focus();
  loadDrawerMedia();
}

function closeMediaDrawer() {
  mediaDrawer.classList.remove('open');
  mediaDrawer.setAttribute('aria-hidden', 'true');
  overlay.classList.remove('visible');
  overlay.setAttribute('aria-hidden', 'true');
}

async function loadDrawerMedia() {
  drawerGrid.innerHTML = '';
  if (drawerEmptyMsg) drawerEmptyMsg.style.display = 'none';
  if (drawerErrorMsg) drawerErrorMsg.style.display = 'none';

  try {
    const res  = await fetch('/api/media', { headers: apiHeaders() });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    if (data.files.length === 0) {
      if (drawerEmptyMsg) drawerEmptyMsg.style.display = '';
    } else {
      data.files.forEach(f => drawerGrid.appendChild(buildDrawerCard(f)));
    }
  } catch {
    if (drawerErrorMsg) {
      drawerErrorMsg.textContent = 'Could not load media. Try again.';
      drawerErrorMsg.style.display = '';
    }
  }
}

function buildDrawerCard(file) {
  const isPdf = file.mime_type === 'application/pdf';
  const card  = document.createElement('div');
  card.className  = 'media-card';
  card.dataset.id = file.id;
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `Attach ${file.filename}`);

  card.innerHTML = `
    <div class="media-thumb">
      ${isPdf
        ? `<div class="media-pdf-thumb" aria-hidden="true">
             <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
               <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
               <polyline points="14 2 14 8 20 8"/>
             </svg>
             <span>PDF</span>
           </div>`
        : `<img src="${file.url}" alt="${escHtml(file.filename)}" loading="lazy">`
      }
    </div>
    <div class="media-card-info">
      <span class="media-filename" title="${escHtml(file.filename)}">${escHtml(truncMediaName(file.filename))}</span>
      <span class="media-format-tag">${escHtml(file.format_tag || 'File')}</span>
    </div>
  `;

  const attach = () => {
    const assetType = isPdf ? 'media_pdf' : 'media_image';
    attachedAssetUrl   = file.url;
    attachedAssetType  = assetType;
    attachedPreviewUrl = isPdf ? null : file.url;
    attachedSlideCount = 0;

    assetChipLabel.textContent = isPdf ? 'PDF' : (file.format_tag || 'Image');
    assetChip.classList.remove('hidden');
    renderPreviewAsset();

    // Persist to session so it survives navigation
    if (currentPostId) Session.save(buildSession());

    closeMediaDrawer();
  };

  card.addEventListener('click', attach);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); attach(); } });
  return card;
}

/* ── Drawer upload zone ──────────────────────────────────────── */
drawerUploadZone.addEventListener('click', () => drawerFileInput.click());

drawerFileInput.addEventListener('change', () => {
  if (drawerFileInput.files.length) drawerProcessFiles(Array.from(drawerFileInput.files));
  drawerFileInput.value = '';
});

drawerUploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  drawerUploadZone.classList.add('dragover');
});
drawerUploadZone.addEventListener('dragleave', () => drawerUploadZone.classList.remove('dragover'));
drawerUploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  drawerUploadZone.classList.remove('dragover');
  const files = Array.from(e.dataTransfer.files);
  if (files.length) drawerProcessFiles(files);
});

async function drawerProcessFiles(files) {
  drawerUploadZone.classList.add('uploading');
  for (const file of files) {
    try {
      await drawerUploadFile(file);
    } catch (err) {
      if (drawerErrorMsg) {
        drawerErrorMsg.textContent = err.message || 'Upload failed';
        drawerErrorMsg.style.display = '';
      }
    }
  }
  drawerUploadZone.classList.remove('uploading');
}

async function drawerUploadFile(file) {
  const ALLOWED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
  if (!ALLOWED.includes(file.type)) throw new Error(`${file.name}: unsupported type`);
  if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: exceeds 20 MB`);

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

  const card = buildDrawerCard(data.file);
  drawerGrid.prepend(card);
  if (drawerEmptyMsg) drawerEmptyMsg.style.display = 'none';
}

function truncMediaName(name, max = 18) {
  if (name.length <= max) return name;
  const ext = name.lastIndexOf('.');
  if (ext > 0) {
    const base = name.slice(0, ext), suffix = name.slice(ext);
    return base.slice(0, max - suffix.length - 1) + '…' + suffix;
  }
  return name.slice(0, max - 1) + '…';
}

/* ── 25. Helpers ─────────────────────────────────────────────── */
function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

'use strict';

// Flow: LinkedIn → Website → What you do + Industry → Results & method →
//       Brand personality → Target audience → Writing sample → Celebration
const STEPS = ['s2','s3','s4','se','s6','s7','sw','s9'];

const state = {
  linkedinConnected: false,
  websiteUrl: null,
  brandDescription: '',
  brandIndustry: '',
  audienceExtracted: '',
  elevatorResultExtracted: '',
  brandPersonalityTraits: [],
  audienceDescription: '',
  elevatorResult: '',
  elevatorMechanism: '',
  writingSample: '',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const TRANSITION_MS = 300;

function transitionScreen(id, direction) {
  const all      = document.querySelectorAll('.ob-screen');
  const entering = document.getElementById('ob-' + id);
  if (!entering) return;

  const exiting = document.querySelector('.ob-screen.active');

  const exitClass  = direction === 'forward' ? 'ob-exiting-forward'  : 'ob-exiting-back';
  const enterClass = direction === 'forward' ? 'ob-entering-forward' : 'ob-entering-back';

  // Strip any leftover animation classes
  all.forEach(s => s.classList.remove(
    'ob-entering-forward','ob-entering-back',
    'ob-exiting-forward','ob-exiting-back'
  ));

  if (exiting && exiting !== entering) {
    exiting.classList.remove('active');
    exiting.classList.add(exitClass);
    setTimeout(() => exiting.classList.remove(exitClass), TRANSITION_MS);
  }

  entering.classList.add('active', enterClass);
  setTimeout(() => entering.classList.remove(enterClass), TRANSITION_MS);

  updateProgress(id);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function showScreen(id) {
  transitionScreen(id, 'forward');
}

function showScreenBack(id) {
  transitionScreen(id, 'back');
}

function updateProgress(id) {
  const track = document.getElementById('ob-progress-track');
  const fill  = document.getElementById('ob-progress-fill');
  const labels = document.querySelectorAll('.ob-progress-step-label');
  if (!track) return;

  const idx = STEPS.indexOf(id);
  if (idx < 0 || id === 's9') {
    track.hidden = true;
    return;
  }

  track.hidden = false;
  const pct = Math.round(((idx + 0.5) / (STEPS.length - 1)) * 100);
  if (fill) fill.style.width = pct + '%';

  labels.forEach((label, i) => {
    label.classList.toggle('active', i === idx);
    label.classList.toggle('done',   i < idx);
  });
}

// Puts a primary button into a loading state (spinner + dimmed) and restores it.
function setButtonLoading(btn, loading) {
  if (loading) {
    btn.dataset.obOrigText = btn.textContent;
    btn.textContent = 'One moment…';
    btn.classList.add('ob-btn--loading');
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.obOrigText || btn.textContent;
    btn.classList.remove('ob-btn--loading');
    btn.disabled = false;
  }
}

// Fades out and removes the init overlay.
function hideInitOverlay() {
  const overlay = document.getElementById('ob-init-overlay');
  if (!overlay) return;
  overlay.classList.add('ob-init-overlay--hiding');
  setTimeout(() => overlay.remove(), 280);
}

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('API error ' + r.status);
  return r.json();
}

function fireConfetti() {
  const fn = window.confetti;
  if (typeof fn !== 'function') return;
  requestAnimationFrame(() => {
    fn({ particleCount: 400, startVelocity: 55, spread: 100, origin: { x: 0.5, y: 0.6 }, ticks: 180, zIndex: 9999 });
    setTimeout(() => {
      fn({ particleCount: 250, startVelocity: 65, spread: 60, angle: 60,  origin: { x: 0,   y: 0.65 }, ticks: 160, zIndex: 9999 });
      fn({ particleCount: 250, startVelocity: 65, spread: 60, angle: 120, origin: { x: 1,   y: 0.65 }, ticks: 160, zIndex: 9999 });
    }, 150);
    setTimeout(() => {
      fn({ particleCount: 300, startVelocity: 60, spread: 80, origin: { x: 0.3, y: 0.7 }, ticks: 150, zIndex: 9999 });
      fn({ particleCount: 300, startVelocity: 60, spread: 80, origin: { x: 0.7, y: 0.7 }, ticks: 150, zIndex: 9999 });
    }, 300);
  });
}

// ── Step 1: LinkedIn ──────────────────────────────────────────────────────────

function initS2() {
  document.getElementById('ob-s2-skip').addEventListener('click', () => showScreen('s3'));
  document.getElementById('ob-s2-next').addEventListener('click', () => showScreen('s3'));
}

async function initLinkedInScreen() {
  const liLoader = document.getElementById('ob-li-status-loader');
  const liDisc   = document.getElementById('ob-li-disconnected');
  if (liLoader) { liLoader.hidden = false; liDisc.hidden = true; }
  try {
    const data = await fetch('/api/linkedin/status').then(r => r.json());
    if (data.connected) {
      state.linkedinConnected = true;
      const card  = document.getElementById('ob-li-connected');
      const disc  = document.getElementById('ob-li-disconnected');
      const photo = document.getElementById('ob-li-photo');
      const name  = document.getElementById('ob-li-name');

      photo.src = data.photo_url || '';
      photo.alt = data.name || '';
      photo.hidden = !data.photo_url;
      name.textContent = data.name || '';

      card.hidden = false;
      disc.hidden = true;
      document.getElementById('ob-s2-next').hidden = false;
      document.getElementById('ob-s2-skip').hidden = true;
    } else {
      document.getElementById('ob-li-connect-btn').href = '/api/linkedin/connect?from=onboarding';
    }
  } catch (_) {}

  if (liLoader) { liLoader.hidden = true; liDisc.hidden = false; }
}

function checkLinkedInReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('linkedin') === 'connected') {
    history.replaceState({}, '', window.location.pathname);
    showScreen('s2');
    initLinkedInScreen();
    return true;
  }
  return false;
}

// ── Step 2: Website URL ───────────────────────────────────────────────────────

function initS3() {
  document.getElementById('ob-s3-back').addEventListener('click', () => showScreenBack('s2'));
  document.getElementById('ob-website-next').addEventListener('click', () => submitWebsite());
  document.getElementById('ob-website-skip').addEventListener('click', () => showScreen('s4'));
  document.getElementById('ob-website-url').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitWebsite();
  });
}

async function submitWebsite() {
  const input   = document.getElementById('ob-website-url');
  const errEl   = document.getElementById('ob-website-error');
  const spinner = document.getElementById('ob-website-extracting');
  const nextBtn = document.getElementById('ob-website-next');
  const skipBtn = document.getElementById('ob-website-skip');

  let url = input.value.trim();
  if (!url) { showScreen('s4'); return; }

  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch {
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;
  state.websiteUrl = url;

  spinner.hidden = false;
  nextBtn.disabled = true;
  skipBtn.disabled = true;

  try {
    const data = await apiPost('/api/profile/extract-website', { url });
    if (data.brand_description)    state.brandDescription       = data.brand_description;
    if (data.audience_description) state.audienceExtracted       = data.audience_description;
    if (data.elevator_main_result) state.elevatorResultExtracted = data.elevator_main_result;

    // Pre-fill step 3 (s4) textarea immediately
    if (state.brandDescription) {
      document.getElementById('ob-brand-description').value = state.brandDescription;
      document.getElementById('ob-brand-prefill-hint').hidden = false;
    }
  } catch (_) {}

  spinner.hidden = true;
  nextBtn.disabled = false;
  skipBtn.disabled = false;
  showScreen('s4');
}

// ── Step 3: What do you do? + Industry ───────────────────────────────────────

function initS4() {
  document.getElementById('ob-s4-back').addEventListener('click', () => showScreenBack('s3'));

  document.getElementById('ob-s4-next').addEventListener('click', () => {
    state.brandDescription = document.getElementById('ob-brand-description').value.trim();
    state.brandIndustry    = document.getElementById('ob-brand-industry').value;
    showScreen('se');
    initSeScreen();
  });
}

// ── Step 4: Results & method ──────────────────────────────────────────────────

function initSe() {
  document.getElementById('ob-se-back').addEventListener('click', () => showScreenBack('s4'));

  document.getElementById('ob-se-next').addEventListener('click', () => {
    state.elevatorResult    = document.getElementById('ob-elevator-result').value.trim();
    state.elevatorMechanism = document.getElementById('ob-elevator-mechanism').value.trim();
    showScreen('s6');
  });

  document.getElementById('ob-se-skip').addEventListener('click', () => {
    state.elevatorResult    = '';
    state.elevatorMechanism = '';
    showScreen('s6');
  });
}

function initSeScreen() {
  const resultInput = document.getElementById('ob-elevator-result');
  const hint        = document.getElementById('ob-elevator-prefill-hint');
  if (state.elevatorResultExtracted && !resultInput.value.trim()) {
    resultInput.value = state.elevatorResultExtracted;
    hint.hidden = false;
  }
}

// ── Step 5: Brand personality ─────────────────────────────────────────────────

function initS6() {
  document.getElementById('ob-s6-back').addEventListener('click', () => showScreenBack('se'));

  const countEl = document.getElementById('ob-trait-count');
  document.querySelectorAll('.ob-trait-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const isSelected = chip.getAttribute('aria-pressed') === 'true';
      if (!isSelected && state.brandPersonalityTraits.length >= 5) return;

      const next = !isSelected;
      chip.setAttribute('aria-pressed', String(next));
      chip.classList.toggle('ob-trait-chip--selected', next);

      // Spring animation
      chip.classList.add('ob-chip-selecting');
      setTimeout(() => chip.classList.remove('ob-chip-selecting'), 280);

      if (next) {
        state.brandPersonalityTraits.push(chip.dataset.trait);
      } else {
        state.brandPersonalityTraits = state.brandPersonalityTraits.filter(t => t !== chip.dataset.trait);
      }
      countEl.style.color = '';
      countEl.textContent = state.brandPersonalityTraits.length + ' / 5 selected';

      // Auto-advance when 5 are selected
      if (state.brandPersonalityTraits.length === 5) {
        setTimeout(() => runBrandVoiceExtraction(), 500);
      }
    });
  });

  document.getElementById('ob-s6-next').addEventListener('click', async () => {
    if (state.brandPersonalityTraits.length === 0) {
      countEl.textContent = 'Pick at least 1 trait to continue';
      countEl.style.color = '#ef4444';
      return;
    }
    await runBrandVoiceExtraction();
  });
}

async function runBrandVoiceExtraction() {
  const nextBtn = document.getElementById('ob-s6-next');
  setButtonLoading(nextBtn, true);

  try {
    await apiPost('/api/profile', {
      brand_description:        state.brandDescription,
      brand_industry:           state.brandIndustry,
      brand_personality_traits: JSON.stringify(state.brandPersonalityTraits),
      elevator_main_result:     state.elevatorResult,
      elevator_mechanism:       state.elevatorMechanism,
    });
  } catch (_) {}

  // Fire prefill generation in background — don't block progression
  apiPost('/api/profile/brand-voice/generate', { mode: 'prefill' }).then(result => {
    if (!result?.prefill) return;
    const p    = result.prefill;
    const save = {};
    if (p.elevator_main_result)         save.elevator_main_result  = p.elevator_main_result;
    if (p.elevator_mechanism)           save.elevator_mechanism    = p.elevator_mechanism;
    if (p.brand_archetype)              save.brand_archetype       = p.brand_archetype;
    if (p.brand_core_beliefs?.length)   save.brand_core_beliefs    = JSON.stringify(p.brand_core_beliefs);
    if (p.brand_phrases_to_use?.length) save.brand_phrases_to_use  = JSON.stringify(p.brand_phrases_to_use);
    if (p.brand_story_origin)           save.brand_story_origin    = p.brand_story_origin;
    if (p.brand_emotional_tone)         save.brand_emotional_tone  = p.brand_emotional_tone;
    if (Object.keys(save).length) apiPost('/api/profile', save).catch(() => {});
  }).catch(() => {});

  setButtonLoading(nextBtn, false);
  showScreen('s7');
  initS7Prefill();
}

// ── Step 6: Target audience ───────────────────────────────────────────────────

function initS7() {
  document.getElementById('ob-s7-back').addEventListener('click', () => showScreenBack('s6'));

  document.getElementById('ob-s7-next').addEventListener('click', async () => {
    state.audienceDescription = document.getElementById('ob-audience-description').value.trim();
    await runAudienceExtraction();
  });
}

function initS7Prefill() {
  const ta   = document.getElementById('ob-audience-description');
  const hint = document.getElementById('ob-audience-prefill-hint');
  if (state.audienceExtracted && !ta.value.trim()) {
    ta.value = state.audienceExtracted;
    hint.hidden = false;
  }
}

async function runAudienceExtraction() {
  const spinner = document.getElementById('ob-aud-generating');
  const nextBtn = document.getElementById('ob-s7-next');

  spinner.hidden = false;
  setButtonLoading(nextBtn, true);

  try {
    await apiPost('/api/profile', { audience_description: state.audienceDescription });

    const result = await apiPost('/api/profile/audience/generate', { mode: 'prefill' });

    if (result.prefill) {
      const p    = result.prefill;
      const save = {};
      if (p.audience_goals?.length)               save.audience_goals                = JSON.stringify(p.audience_goals);
      if (p.audience_obstacles?.length)           save.audience_obstacles             = JSON.stringify(p.audience_obstacles);
      if (p.audience_core_beliefs_market?.length) save.audience_core_beliefs_market   = JSON.stringify(p.audience_core_beliefs_market);
      if (p.audience_buying_stage)                save.audience_buying_stage          = p.audience_buying_stage;
      if (p.audience_market_sophistication)       save.audience_market_sophistication = p.audience_market_sophistication;
      if (p.audience_profile_json)                save.audience_profile_json          = p.audience_profile_json;
      if (Object.keys(save).length) await apiPost('/api/profile', save);
    }
  } catch (_) {}

  spinner.hidden = true;
  setButtonLoading(nextBtn, false);
  showScreen('sw');
}

// ── Step 7: Writing sample ────────────────────────────────────────────────────

function initSw() {
  document.getElementById('ob-sw-back').addEventListener('click', () => showScreenBack('s7'));

  const ta        = document.getElementById('ob-writing-sample');
  const charCount = document.getElementById('ob-writing-char-count');

  ta.addEventListener('input', () => {
    const len = ta.value.length;
    charCount.textContent = len > 0 ? len + ' / 1200 characters' : '';
  });

  document.getElementById('ob-sw-next').addEventListener('click', async () => {
    state.writingSample = ta.value.trim();
    await saveAndFinish();
  });

  document.getElementById('ob-sw-skip').addEventListener('click', async () => {
    state.writingSample = '';
    await saveAndFinish();
  });
}

async function saveAndFinish() {
  const nextBtn  = document.getElementById('ob-sw-next');
  const skipBtn  = document.getElementById('ob-sw-skip');
  const savingEl = document.getElementById('ob-sw-saving');
  setButtonLoading(nextBtn, true);
  skipBtn.disabled = true;
  if (savingEl) savingEl.hidden = false;

  try {
    const payload = {
      onboarding_complete:     1,
      onboarding_completed_at: new Date().toISOString(),
    };
    if (state.writingSample) payload.writing_samples = state.writingSample;
    const result = await apiPost('/api/profile', payload);
    if (!result?.ok) throw new Error(result?.error || 'save_failed');
  } catch (err) {
    setButtonLoading(nextBtn, false);
    skipBtn.disabled = false;
    if (savingEl) savingEl.hidden = true;
    alert('Something went wrong saving your profile. Please try again.');
    console.error('[onboarding] saveAndFinish failed:', err?.message);
    return;
  }

  setButtonLoading(nextBtn, false);
  skipBtn.disabled = false;
  if (savingEl) savingEl.hidden = true;

  showScreen('s9');
  setTimeout(fireConfetti, 120);
}

// ── Celebration ───────────────────────────────────────────────────────────────

function initS9() {
  document.getElementById('ob-write-first-post').addEventListener('click', () => {
    window.location.href = '/generate.html';
  });
}

// ── Keyboard navigation ───────────────────────────────────────────────────────

function initKeyboard() {
  const nextMap = {
    s2: 'ob-s2-next',
    s3: 'ob-website-next',
    s4: 'ob-s4-next',
    se: 'ob-se-next',
    s6: 'ob-s6-next',
    s7: 'ob-s7-next',
    sw: 'ob-sw-next',
    s9: 'ob-write-first-post',
  };
  const backMap = {
    s3: 'ob-s3-back',
    s4: 'ob-s4-back',
    se: 'ob-se-back',
    s6: 'ob-s6-back',
    s7: 'ob-s7-back',
    sw: 'ob-sw-back',
  };

  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (tag === 'TEXTAREA' && e.key !== 'Escape') return;
    if (tag === 'SELECT') return;

    const active = document.querySelector('.ob-screen.active');
    if (!active) return;
    const sid = active.id.replace('ob-', '');

    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById(nextMap[sid])?.click();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      document.getElementById(backMap[sid])?.click();
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const me = await fetch('/api/auth/me').then(r => r.json());
    if (!me?.user?.user_id) { window.location.href = '/login.html'; return; }
    // Skip wizard if the current workspace has already been set up — handles the
    // case where a user navigates here manually on an already-configured workspace.
    const profileRes = await fetch('/api/profile').then(r => r.json());
    if (profileRes?.profile?.onboarding_complete) { window.location.href = '/dashboard.html'; return; }
  } catch {
    window.location.href = '/login.html';
    return;
  }

  hideInitOverlay();

  initS2();
  initS3();
  initS4();
  initSe();
  initS6();
  initS7();
  initSw();
  initS9();
  initKeyboard();

  // Must come after all init calls so DOM is wired
  if (checkLinkedInReturn()) return;

  showScreen('s2');
  initLinkedInScreen();
}

init();

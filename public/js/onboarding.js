'use strict';

const STEPS = ['s1','s2','s3','s4','se','s5','s6','s7','s8','sw','s9'];

const state = {
  role: null,
  linkedinConnected: false,
  websiteUrl: null,
  brandDescription: '',
  audienceExtracted: '',
  elevatorResultExtracted: '',
  brandIndustry: '',
  brandPersonalityTraits: [],
  audiencePrimary: '',
  audienceDetail: '',
  elevatorResult: '',
  elevatorMechanism: '',
  writingSample: '',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.ob-screen').forEach(s => s.hidden = true);
  const el = document.getElementById('ob-' + id);
  if (el) el.hidden = false;

  const dots = document.getElementById('ob-step-dots');
  const idx = STEPS.indexOf(id);
  if (idx < 0 || id === 's9') {
    dots.hidden = true;
  } else {
    dots.hidden = false;
    dots.querySelectorAll('.ob-dot').forEach((d, i) => {
      d.classList.toggle('ob-dot--active', i === idx);
      d.classList.toggle('ob-dot--done', i < idx);
    });
  }

  window.scrollTo({ top: 0, behavior: 'instant' });
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

// ── Step 1: Role ──────────────────────────────────────────────────────────────

function initS1() {
  document.querySelectorAll('.ob-role-card').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.ob-role-card').forEach(b => {
        b.classList.remove('ob-role-card--selected');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('ob-role-card--selected');
      btn.setAttribute('aria-pressed', 'true');
      state.role = btn.dataset.role;
      try { await apiPost('/api/profile', { role: state.role }); } catch (_) {}
      showScreen('s2');
      initLinkedInScreen();
    });
  });
}

// ── Step 2: LinkedIn ──────────────────────────────────────────────────────────

function initS2() {
  document.getElementById('ob-s2-back').addEventListener('click', () => showScreen('s1'));
  document.getElementById('ob-s2-skip').addEventListener('click', () => showScreen('s3'));
  document.getElementById('ob-s2-next').addEventListener('click', () => showScreen('s3'));
}

async function initLinkedInScreen() {
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
      const btn = document.getElementById('ob-li-connect-btn');
      btn.href = '/api/linkedin/connect?from=onboarding';
    }
  } catch (_) {}
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

// ── Step 3: Website URL ───────────────────────────────────────────────────────

function initS3() {
  document.getElementById('ob-s3-back').addEventListener('click', () => showScreen('s2'));
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
    if (data.brand_description)    state.brandDescription        = data.brand_description;
    if (data.audience_description) state.audienceExtracted        = data.audience_description;
    if (data.elevator_main_result) state.elevatorResultExtracted  = data.elevator_main_result;

    // Pre-fill step 4 textarea immediately
    const ta = document.getElementById('ob-brand-description');
    if (state.brandDescription) {
      ta.value = state.brandDescription;
      document.getElementById('ob-brand-prefill-hint').hidden = false;
    }
  } catch (_) {}

  spinner.hidden = true;
  nextBtn.disabled = false;
  skipBtn.disabled = false;
  showScreen('s4');
}

// ── Step 4: What do you do? ───────────────────────────────────────────────────

function initS4() {
  document.getElementById('ob-s4-back').addEventListener('click', () => showScreen('s3'));

  document.getElementById('ob-s4-next').addEventListener('click', () => {
    state.brandDescription = document.getElementById('ob-brand-description').value.trim();
    showScreen('se');
    initSeScreen();
  });
}

// ── Step 5 (new): Elevator — results & method ─────────────────────────────────

function initSe() {
  document.getElementById('ob-se-back').addEventListener('click', () => showScreen('s4'));

  document.getElementById('ob-se-next').addEventListener('click', () => {
    state.elevatorResult    = document.getElementById('ob-elevator-result').value.trim();
    state.elevatorMechanism = document.getElementById('ob-elevator-mechanism').value.trim();
    showScreen('s5');
  });

  document.getElementById('ob-se-skip').addEventListener('click', () => {
    state.elevatorResult    = '';
    state.elevatorMechanism = '';
    showScreen('s5');
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

// ── Step 6: Industry ──────────────────────────────────────────────────────────

function initS5() {
  document.getElementById('ob-s5-back').addEventListener('click', () => showScreen('se'));

  document.getElementById('ob-s5-next').addEventListener('click', () => {
    state.brandIndustry = document.getElementById('ob-brand-industry').value;
    showScreen('s6');
  });
}

// ── Step 7: Brand personality ─────────────────────────────────────────────────

function initS6() {
  document.getElementById('ob-s6-back').addEventListener('click', () => showScreen('s5'));

  const countEl = document.getElementById('ob-trait-count');
  document.querySelectorAll('.ob-trait-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const isSelected = chip.getAttribute('aria-pressed') === 'true';
      if (!isSelected && state.brandPersonalityTraits.length >= 5) return;

      const next = !isSelected;
      chip.setAttribute('aria-pressed', String(next));
      chip.classList.toggle('ob-trait-chip--selected', next);

      if (next) {
        state.brandPersonalityTraits.push(chip.dataset.trait);
      } else {
        state.brandPersonalityTraits = state.brandPersonalityTraits.filter(t => t !== chip.dataset.trait);
      }
      countEl.textContent = state.brandPersonalityTraits.length + ' / 5 selected';
    });
  });

  document.getElementById('ob-s6-next').addEventListener('click', async () => {
    await runBrandVoiceExtraction();
  });
}

async function runBrandVoiceExtraction() {
  const spinner = document.getElementById('ob-bv-generating');
  const nextBtn = document.getElementById('ob-s6-next');

  spinner.hidden = false;
  nextBtn.disabled = true;

  try {
    await apiPost('/api/profile', {
      brand_description:        state.brandDescription,
      brand_industry:           state.brandIndustry,
      brand_personality_traits: JSON.stringify(state.brandPersonalityTraits),
      elevator_main_result:     state.elevatorResult,
      elevator_mechanism:       state.elevatorMechanism,
    });

    const result = await apiPost('/api/profile/brand-voice/generate', { mode: 'prefill' });

    if (result.prefill) {
      const p    = result.prefill;
      const save = {};
      if (p.elevator_main_result)         save.elevator_main_result  = p.elevator_main_result;
      if (p.elevator_mechanism)           save.elevator_mechanism    = p.elevator_mechanism;
      if (p.brand_archetype)              save.brand_archetype       = p.brand_archetype;
      if (p.brand_core_beliefs?.length)   save.brand_core_beliefs    = JSON.stringify(p.brand_core_beliefs);
      if (p.brand_phrases_to_use?.length) save.brand_phrases_to_use  = JSON.stringify(p.brand_phrases_to_use);
      if (p.brand_story_origin)           save.brand_story_origin    = p.brand_story_origin;
      if (p.brand_emotional_tone)         save.brand_emotional_tone  = p.brand_emotional_tone;
      if (Object.keys(save).length) await apiPost('/api/profile', save);
    }
  } catch (_) {}

  spinner.hidden = true;
  nextBtn.disabled = false;
  showScreen('s7');
  initS7Prefill();
}

// ── Step 8: Target audience ───────────────────────────────────────────────────

function initS7() {
  document.getElementById('ob-s7-back').addEventListener('click', () => showScreen('s6'));

  document.getElementById('ob-s7-next').addEventListener('click', () => {
    state.audiencePrimary = document.getElementById('ob-audience-primary').value.trim();
    showScreen('s8');
  });
}

function initS7Prefill() {
  const ta   = document.getElementById('ob-audience-primary');
  const hint = document.getElementById('ob-audience-prefill-hint');
  if (state.audienceExtracted && !ta.value.trim()) {
    ta.value = state.audienceExtracted;
    hint.hidden = false;
  }
}

// ── Step 9: Demographics ──────────────────────────────────────────────────────

function initS8() {
  document.getElementById('ob-s8-back').addEventListener('click', () => showScreen('s7'));

  document.getElementById('ob-s8-next').addEventListener('click', async () => {
    state.audienceDetail = document.getElementById('ob-audience-detail').value.trim();
    await runAudienceExtraction();
  });
}

async function runAudienceExtraction() {
  const spinner = document.getElementById('ob-aud-generating');
  const nextBtn = document.getElementById('ob-s8-next');

  spinner.hidden = false;
  nextBtn.disabled = true;

  try {
    const combined = [state.audiencePrimary, state.audienceDetail].filter(Boolean).join('. ');
    await apiPost('/api/profile', { audience_description: combined });

    const result = await apiPost('/api/profile/audience/generate', { mode: 'prefill' });

    if (result.prefill) {
      const p    = result.prefill;
      const save = {};
      if (p.audience_goals?.length)              save.audience_goals                = JSON.stringify(p.audience_goals);
      if (p.audience_obstacles?.length)          save.audience_obstacles             = JSON.stringify(p.audience_obstacles);
      if (p.audience_core_beliefs_market?.length) save.audience_core_beliefs_market  = JSON.stringify(p.audience_core_beliefs_market);
      if (p.audience_buying_stage)               save.audience_buying_stage          = p.audience_buying_stage;
      if (p.audience_market_sophistication)      save.audience_market_sophistication = p.audience_market_sophistication;
      if (p.audience_profile_json)               save.audience_profile_json          = p.audience_profile_json;
      if (Object.keys(save).length) await apiPost('/api/profile', save);
    }
  } catch (_) {}

  spinner.hidden = true;
  nextBtn.disabled = false;

  // Advance to writing sample — not celebration yet
  showScreen('sw');
}

// ── Step 10 (new): Writing sample ────────────────────────────────────────────

function initSw() {
  document.getElementById('ob-sw-back').addEventListener('click', () => showScreen('s8'));

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
  const nextBtn = document.getElementById('ob-sw-next');
  const skipBtn = document.getElementById('ob-sw-skip');
  nextBtn.disabled = true;
  skipBtn.disabled = true;

  try {
    const payload = {
      onboarding_complete:    1,
      onboarding_completed_at: new Date().toISOString(),
    };
    if (state.writingSample) payload.writing_samples = state.writingSample;
    await apiPost('/api/profile', payload);
  } catch (_) {}

  nextBtn.disabled = false;
  skipBtn.disabled = false;

  showScreen('s9');
  setTimeout(fireConfetti, 120);
}

// ── Step 11: Celebration ──────────────────────────────────────────────────────

function initS9() {
  document.getElementById('ob-write-first-post').addEventListener('click', () => {
    window.location.href = '/generate.html';
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const me = await fetch('/api/auth/me').then(r => r.json());
    if (!me || !me.id) { window.location.href = '/login.html'; return; }
    if (me.onboarding_complete) { window.location.href = '/dashboard.html'; return; }
  } catch {
    window.location.href = '/login.html';
    return;
  }

  document.querySelectorAll('.ob-screen').forEach(s => s.hidden = true);

  initS1();
  initS2();
  initS3();
  initS4();
  initSe();
  initS5();
  initS6();
  initS7();
  initS8();
  initSw();
  initS9();

  // Must come after all init calls so DOM is wired
  if (checkLinkedInReturn()) return;

  showScreen('s1');
}

init();

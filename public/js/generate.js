/* generate.js — Sprint 3 state machine */

/* ── Helpers ─────────────────────────────────────────────────── */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── State ───────────────────────────────────────────────────── */
let selectedType      = null; // 'reach'|'trust'|'convert'|'lead_magnet'|'freewrite'
let selectedVaultIdea = null; // { id, seed_text, funnel_type }
let mixRecommended    = null;

/* ── DOM refs ────────────────────────────────────────────────── */
const typeSelectorSection = document.getElementById('type-selector-section');
const typeChips           = document.querySelectorAll('.type-chip');
const confirmedChip       = document.getElementById('confirmed-chip');
const confirmedChipLabel  = document.getElementById('confirmed-chip-label');
const confirmedChipChange = document.getElementById('confirmed-chip-change');
const inputPane           = document.getElementById('input-pane');
const lmPane              = document.getElementById('lm-pane');
const processingScreen    = document.getElementById('processing-screen');
const ideaInput           = document.getElementById('idea-input');
const ideaError           = document.getElementById('idea-error');
const ideaCharCount       = document.getElementById('idea-char-count');
const substanceWarning    = document.getElementById('substance-warning');
const substanceWarningTx  = document.getElementById('substance-warning-text');
const generateBtnAnyway   = document.getElementById('generate-btn-anyway');
const generateBtn         = document.getElementById('generate-btn');
const generateError       = document.getElementById('generate-error');
const convertCtaRow       = document.getElementById('convert-cta-row');
const convertCtaInput     = document.getElementById('convert-cta-input');
const voiceIndicator      = document.getElementById('voice-indicator-area');
const startersOverlay     = document.getElementById('starters-overlay');
const startersList        = document.getElementById('starters-list');
const startersLabel       = document.getElementById('starters-label');
const vaultToggleBtn      = document.getElementById('vault-toggle-btn');
const vaultPickerListWrap = document.getElementById('vault-picker-list-wrap');
const vaultPickerList     = document.getElementById('vault-picker-list');

/* ── Type labels ─────────────────────────────────────────────── */
const TYPE_LABELS = {
  reach:       '📣 Reach post',
  trust:       '🎯 Trust post',
  convert:     '📞 Convert post',
  lead_magnet: '🎁 Lead magnet',
  freewrite:   '✏️ Free write',
};

/* ── Type selection ──────────────────────────────────────────── */
function selectType(type) {
  selectedType = type;
  typeSelectorSection.style.display = 'none';
  processingScreen.classList.remove('visible');

  if (type === 'freewrite') {
    confirmedChip.classList.remove('visible');
  } else {
    confirmedChipLabel.textContent = '✓ ' + TYPE_LABELS[type];
    confirmedChip.classList.add('visible');
  }

  if (type === 'lead_magnet') {
    inputPane.classList.remove('visible');
    lmPane.classList.add('visible');
    lm.init();
  } else {
    lmPane.classList.remove('visible');
    inputPane.classList.add('visible');

    if (selectedVaultIdea) {
      ideaInput.value = selectedVaultIdea.seed_text || '';
      ideaInput.dispatchEvent(new Event('input'));
      startersOverlay.classList.remove('visible');
    } else {
      loadTopicStarters(type);
    }
    ideaInput.focus();
  }
}

function resetType() {
  selectedType      = null;
  selectedVaultIdea = null;

  typeSelectorSection.style.display = '';
  confirmedChip.classList.remove('visible');
  inputPane.classList.remove('visible');
  lmPane.classList.remove('visible');
  processingScreen.classList.remove('visible');

  ideaInput.value = '';
  ideaInput.style.height = '';
  ideaInput.classList.remove('error');
  ideaError.classList.remove('visible');
  ideaCharCount.textContent = '';
  substanceWarning.classList.remove('visible');
  generateError.classList.remove('visible');
  convertCtaRow.classList.remove('visible');
  if (convertCtaInput) convertCtaInput.value = '';

  markRecommendedChip();
}

typeChips.forEach(chip => {
  chip.addEventListener('click', () => selectType(chip.dataset.type));
});
confirmedChipChange.addEventListener('click', resetType);

/* ── Mix recommendation ──────────────────────────────────────── */
async function loadMixRecommendation() {
  try {
    const res  = await fetch('/api/posts/mix-recommendation', { headers: apiHeaders() });
    const data = await res.json();
    if (!data.ok) return;

    mixRecommended = data.recommended_type || null;

    if (data.has_enough_data && data.nudge && mixRecommended) {
      const nudgeEl    = document.getElementById('mix-nudge');
      const questionEl = document.getElementById('gen-question');
      if (nudgeEl)    { nudgeEl.textContent = '✦ ' + data.nudge; nudgeEl.style.display = ''; }
      if (questionEl)   questionEl.textContent = 'Time to mix it up?';
    }

    markRecommendedChip();
  } catch { /* non-fatal */ }
}

function markRecommendedChip() {
  typeChips.forEach(chip => {
    chip.querySelector('.chip-star')?.remove();
    if (chip.dataset.type === mixRecommended) {
      const s = document.createElement('span');
      s.className = 'chip-star';
      s.textContent = ' ✦';
      chip.appendChild(s);
    }
  });
}

/* ── Voice profile indicator ─────────────────────────────────── */
async function loadProfile() {
  try {
    const uid  = getUserId();
    const res  = await fetch(`/api/profile/${uid}`, { headers: apiHeaders() });
    const data = await res.json();
    const p    = data.profile;
    const ok   = p && p.content_niche && p.audience_role && p.audience_pain;
    voiceIndicator.innerHTML = ok
      ? `<div class="voice-indicator"><span class="voice-indicator-dot voice-indicator-dot--green"></span><a href="/settings.html" class="edit-link">Created using your voice profile</a></div>`
      : `<div class="voice-indicator"><span class="voice-indicator-dot voice-indicator-dot--red"></span><a href="/settings.html" class="edit-link">Voice profile incomplete — complete it for better results</a></div>`;
  } catch {
    voiceIndicator.innerHTML = `<div class="voice-indicator"><span class="voice-indicator-dot voice-indicator-dot--red"></span><a href="/settings.html" class="edit-link">Voice profile incomplete — complete it for better results</a></div>`;
  }
}

/* ── Textarea auto-grow + char count ─────────────────────────── */
ideaInput.addEventListener('input', () => {
  ideaInput.style.height = 'auto';
  ideaInput.style.height = ideaInput.scrollHeight + 'px';
  clearInputError();
  updateCharCount();
  maybeShowConvertCta();
  if (ideaInput.value.trim()) startersOverlay.classList.remove('visible');
});

function updateCharCount() {
  const len = ideaInput.value.length;
  if (len === 0) { ideaCharCount.textContent = ''; ideaCharCount.className = 'gen-char-count'; return; }
  if (len < 80)  { ideaCharCount.textContent = `${len} / 80 characters minimum`; ideaCharCount.className = 'gen-char-count warn'; }
  else           { ideaCharCount.textContent = ''; ideaCharCount.className = 'gen-char-count'; }
}

function maybeShowConvertCta() {
  if (selectedType === 'convert' && ideaInput.value.length >= 80) {
    convertCtaRow.classList.add('visible');
  } else {
    convertCtaRow.classList.remove('visible');
  }
}

/* ── Topic starters ──────────────────────────────────────────── */
const startersCache = {};

async function loadTopicStarters(postType) {
  if (ideaInput.value.trim()) return;

  const key = postType || 'generic';
  updateStartersLabel(postType);

  if (startersCache[key]) {
    renderStarters(startersCache[key], postType);
    return;
  }

  startersList.innerHTML = `<div class="starter-skeleton"></div><div class="starter-skeleton"></div><div class="starter-skeleton"></div>`;
  startersOverlay.classList.add('visible');

  try {
    const qs  = postType && postType !== 'freewrite' ? `?post_type=${postType}` : '';
    const res  = await fetch(`/api/vault/suggest-topics${qs}`, { headers: apiHeaders() });
    const data = await res.json();
    if (!data.ok || !data.topics?.length) { startersOverlay.classList.remove('visible'); return; }
    startersCache[key] = data.topics;
    renderStarters(data.topics, postType);
  } catch {
    startersOverlay.classList.remove('visible');
  }
}

function updateStartersLabel(postType) {
  const LABELS = {
    reach: 'Topics to write about:', trust: 'Topics to write about:',
    convert: 'Topics to write about:', lead_magnet: 'Ideas for your free resource:',
  };
  if (startersLabel) startersLabel.textContent = LABELS[postType] || 'Not sure where to start?';
}

function renderStarters(topics, postType) {
  startersList.innerHTML = topics.map(t => `
    <button class="starter-btn" type="button"
            data-title="${escapeHtml(t.title)}" data-desc="${escapeHtml(t.description)}">
      <div style="flex:1;min-width:0">
        <p class="starter-btn-title">${escapeHtml(t.title)}</p>
        <p class="starter-btn-desc">${escapeHtml(t.description)}</p>
      </div>
      <span class="starter-arrow" aria-hidden="true">→</span>
    </button>
  `).join('');
  startersList.querySelectorAll('.starter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (postType === 'lead_magnet') {
        lm.prefillResourceName(btn.dataset.title);
      } else {
        ideaInput.value = btn.dataset.title + '\n\n' + btn.dataset.desc;
        ideaInput.focus();
        ideaInput.dispatchEvent(new Event('input'));
      }
      startersOverlay.classList.remove('visible');
    });
  });
  startersOverlay.classList.add('visible');
}

/* ── Vault picker ────────────────────────────────────────────── */
let vaultLoaded = false;

vaultToggleBtn.addEventListener('click', async () => {
  const isOpen = vaultPickerListWrap.classList.contains('open');
  if (isOpen) { vaultPickerListWrap.classList.remove('open'); return; }
  vaultPickerListWrap.classList.add('open');
  if (!vaultLoaded) await loadVaultIdeas();
});

async function loadVaultIdeas() {
  try {
    const res   = await fetch('/api/vault/ideas?status=fresh', { headers: apiHeaders() });
    const data  = await res.json();
    const ideas = (data.ideas || []).slice(0, 6);
    vaultLoaded = true;

    if (!ideas.length) {
      vaultPickerList.innerHTML = `<div class="vault-picker-empty">No vault ideas yet. <a href="/vault.html" style="color:var(--brand)">Mine your documents →</a></div>`;
      return;
    }

    vaultPickerList.innerHTML = ideas.map(idea => {
      const seed    = (idea.seed_text || '').slice(0, 80);
      const ellipsis = idea.seed_text?.length > 80 ? '…' : '';
      const preview = idea.hook_preview || '';
      return `<button class="vault-idea-item" type="button"
                data-id="${idea.id}"
                data-seed="${escapeHtml(idea.seed_text || '')}"
                data-type="${idea.funnel_type || ''}">
        <p class="vault-idea-seed">${escapeHtml(seed)}${ellipsis}</p>
        ${preview ? `<p class="vault-idea-preview">${escapeHtml(preview)}</p>` : ''}
      </button>`;
    }).join('');

    vaultPickerList.querySelectorAll('.vault-idea-item').forEach(item => {
      item.addEventListener('click', () => {
        vaultPickerList.querySelectorAll('.vault-idea-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');

        selectedVaultIdea = {
          id:          item.dataset.id,
          seed_text:   item.dataset.seed,
          funnel_type: item.dataset.type,
        };

        const ft       = item.dataset.type;
        const autoType = (ft === 'reach' || ft === 'trust' || ft === 'convert') ? ft : null;

        if (autoType) {
          vaultPickerListWrap.classList.remove('open');
          selectType(autoType);
        } else {
          vaultPickerListWrap.classList.remove('open');
          // No funnel type — leave user on type selector; idea stored, will pre-fill on type click
        }
      });
    });
  } catch {
    vaultPickerList.innerHTML = `<div class="vault-picker-empty">Could not load ideas. Try refreshing.</div>`;
  }
}

/* ── Generate (Reach / Trust / Convert / Freewrite) ─────────── */
generateBtn.addEventListener('click', () => triggerGenerate());
generateBtnAnyway?.addEventListener('click', () => triggerGenerate({ skipSubstanceCheck: true }));

async function triggerGenerate(opts = {}) {
  clearInputError();

  const idea = ideaInput.value.trim();
  if (!idea)          { showInputError('Add a thought before writing the post'); ideaInput.focus(); return; }
  if (idea.length < 80) { showInputError('Add more of your own words — a few sentences gives us more to work with.'); ideaInput.focus(); return; }

  showProcessingScreen(idea, selectedType);

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 90_000);

  try {
    const body = {
      path:      'idea',
      raw_idea:  idea,
      post_type: selectedType === 'freewrite' ? null : (selectedType || null),
    };
    if (opts.skipSubstanceCheck) body.skip_substance_check = true;
    if (selectedType === 'convert') {
      const intent = convertCtaInput?.value.trim();
      if (intent) body.convert_cta_intent = intent;
    }
    if (selectedVaultIdea?.id) body.vault_idea_id = selectedVaultIdea.id;

    const res  = await fetch('/api/generate', {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify(body), signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json();

    if (!res.ok || !data.ok) {
      const err = new Error(data.error || 'generation_failed');
      if (data.error === 'plan_limit_exceeded') { err.planCurrent = data.current; err.planLimit = data.limit; }
      if (data.error === 'missing_substance')   err.substancePrompt = data.prompt;
      throw err;
    }

    finaliseProcessingSteps(data);
    await sleep(600);
    window.location.href = `/editor/${encodeURIComponent(data.id)}`;

  } catch (err) {
    clearTimeout(timeoutId);
    hideProcessingScreen();

    if (err.name === 'AbortError') {
      showGenerateError('This is taking longer than expected. <a href="#">Try again →</a>');
    } else if (err.message === 'missing_substance') {
      showSubstanceWarning(err.substancePrompt || 'Add a specific outcome or contrarian view to improve this post.');
    } else if (err.message === 'complete_profile_first') {
      showGenerateError('Your voice profile is incomplete — posts need it to generate. <a href="/settings.html">Complete it →</a>');
    } else if (err.message === 'plan_limit_exceeded') {
      const used = (err.planCurrent != null && err.planLimit != null) ? ` You've used ${err.planCurrent} of ${err.planLimit} this month.` : '';
      showGenerateError(`You've reached the free plan limit.${used} <button type="button" onclick="window.PricingModal?.open()" style="background:none;border:none;padding:0;color:var(--brand);font-weight:600;cursor:pointer;font-size:inherit">Upgrade to Pro →</button>`);
    } else if (err.message === 'rate_limit_exceeded') {
      showGenerateError("You've hit the hourly generation limit. Wait a few minutes and try again.");
    } else if (err.message === 'high_demand') {
      showGenerateError('ScoutHook is under high demand right now. Wait 30 seconds and try again.');
    } else {
      showGenerateError('Something went wrong. <a href="#">Try again →</a>');
    }
  }
}

/* ── Processing screen ───────────────────────────────────────── */
function extractAngleLabel(rawIdea) {
  const FILLER = /^(so|well|i|we|the|a|an|its|it|this|that|here|just|actually|basically)\b\s*/gi;
  const cleaned = rawIdea.replace(/\n.*/s, '').trim();
  const stripped = cleaned.replace(FILLER, '').trim();
  const snippet  = stripped.replace(/[,;:!?].*/, '').slice(0, 40).trim();
  return snippet || 'your idea';
}

function showProcessingScreen(rawIdea, postType) {
  inputPane.classList.remove('visible');
  lmPane.classList.remove('visible');
  confirmedChip.classList.remove('visible');
  processingScreen.classList.add('visible');

  const steps = [
    'Analysing your idea…',
    `Found the angle: ${extractAngleLabel(rawIdea || '')}`,
    'Selecting the hook type…',
    'Final quality check…',
  ];

  for (let i = 0; i < 4; i++) {
    const el = document.getElementById(`proc-step-${i}`);
    if (!el) continue;
    el.className = 'proc-step';
    el.querySelector('.proc-step-icon').innerHTML = '⏳';
    el.querySelector('.proc-step-text').textContent = steps[i];
  }

  let delay = 0;
  for (let i = 0; i < 4; i++) {
    const d = delay;
    setTimeout(() => {
      const el = document.getElementById(`proc-step-${i}`);
      if (!el) return;
      el.classList.add('visible');
      if (i < 3) {
        el.classList.add('done');
        el.querySelector('.proc-step-icon').innerHTML = '✅';
      } else {
        el.querySelector('.proc-step-icon').innerHTML = '<span class="proc-spinner"></span>';
      }
    }, d);
    delay += 800;
  }
}

function finaliseProcessingSteps(data) {
  const archetype = data.archetypeUsed || data.archetype_used;
  const step2 = document.getElementById('proc-step-2');
  if (step2 && archetype) {
    step2.querySelector('.proc-step-text').textContent = `Hook type: ${archetype}`;
    step2.querySelector('.proc-step-icon').innerHTML = '✅';
    step2.classList.add('done');
  }
  const step3 = document.getElementById('proc-step-3');
  if (step3) {
    step3.querySelector('.proc-step-icon').innerHTML = '✅';
    step3.querySelector('.proc-step-text').textContent = 'Ready.';
    step3.classList.add('done', 'visible');
  }
}

function hideProcessingScreen() {
  processingScreen.classList.remove('visible');
  if (selectedType === 'lead_magnet') {
    lmPane.classList.add('visible');
  } else {
    inputPane.classList.add('visible');
    if (selectedType && selectedType !== 'freewrite') confirmedChip.classList.add('visible');
  }
}

/* ── Lead magnet chat state machine ──────────────────────────── */
const lm = (() => {
  let step      = 0;
  let answers   = {};
  let proofMode = 'metric';
  let _pendingPrefill = null;

  const QUESTIONS = [
    { text: 'What are you giving away?',                                          multiline: false },
    { text: "What's inside? One deliverable per line.\nSpecific beats vague.",   multiline: true  },
    { text: "What's your proof? Real numbers only — we won't invent these.\n\ne.g. \"Helped 3 clients go from 500 to 8K followers in 90 days\"\ne.g. \"Used by 40+ consultants to cut proposal time in half\"", multiline: true, hasEscape: true },
    { text: 'Last one — what word should people comment to receive this?',        multiline: false },
  ];

  const PLACEHOLDERS = [
    'e.g. LinkedIn Hook Swipe File',
    'e.g.\n50 fill-in-the-blank hook templates\nOrganised by trigger: curiosity, fear, desire\nReal viral examples showing how each works',
    'Your specific result or proof…',
    'e.g. HOOKS or PLAYBOOK',
  ];

  const ESCAPE_Q = {
    text: 'Who has this worked for? Describe the person or situation.',
    placeholder: 'e.g. "SaaS founders who want to grow their LinkedIn without paid ads"',
    multiline: true,
  };

  function $thread()  { return document.getElementById('lm-thread');       }
  function $input()   { return document.getElementById('lm-input');        }
  function $send()    { return document.getElementById('lm-send-btn');     }
  function $err()     { return document.getElementById('lm-error');        }
  function $genBtn()  { return document.getElementById('lm-generate-btn'); }
  function $genErr()  { return document.getElementById('lm-generate-error'); }
  function $inputRow(){ return document.getElementById('lm-input-row');    }

  function addBot(text, hasEscape) {
    const div = document.createElement('div');
    div.className = 'lm-bubble-bot';
    div.textContent = text;
    if (hasEscape) {
      const btn = document.createElement('button');
      btn.className = 'lm-escape-link';
      btn.textContent = 'No metric yet? Describe who it worked for →';
      btn.addEventListener('click', switchToDescription);
      div.appendChild(document.createElement('br'));
      div.appendChild(btn);
    }
    $thread().appendChild(div);
    $thread().scrollTop = $thread().scrollHeight;
  }

  function addUser(text) {
    const div = document.createElement('div');
    div.className = 'lm-bubble-user';
    div.textContent = text;
    $thread().appendChild(div);
    $thread().scrollTop = $thread().scrollHeight;
  }

  function setInput(q, placeholder) {
    const inp = $input();
    if (!inp) return;
    inp.placeholder = placeholder || '';
    if (q.multiline) { inp.rows = 4; inp.style.minHeight = '100px'; }
    else             { inp.rows = 1; inp.style.minHeight = '44px';  }
    inp.value = '';
    inp.classList.remove('error');
    inp.style.height = '';
    inp.focus();
  }

  function showErr(msg) { const el = $err(); if (el) { el.textContent = msg; el.classList.add('visible'); } }
  function clearErr()   { const el = $err(); if (el) el.classList.remove('visible'); }

  function switchToDescription() {
    proofMode = 'description';
    const bots = $thread().querySelectorAll('.lm-bubble-bot');
    const last = bots[bots.length - 1];
    if (last) { last.textContent = ESCAPE_Q.text; }
    setInput(ESCAPE_Q, ESCAPE_Q.placeholder);
    clearErr();
  }

  function advance() {
    const inp = $input();
    if (!inp) return;
    clearErr();
    const val = inp.value.trim();

    if (step === 0) {
      if (!val) { showErr('What are you giving away? Add a name first.'); inp.focus(); return; }
      answers.resourceName = val;
    } else if (step === 1) {
      const lines = val.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length < 3) {
        showErr("Add at least 3 specific items — readers decide whether to comment based on what's inside.");
        inp.focus(); return;
      }
      answers.deliverables = lines;
    } else if (step === 2) {
      if (!val) {
        showErr("What's your real result? This must come from you — ScoutHook won't invent it.");
        inp.focus(); return;
      }
      answers.proof     = val;
      answers.proofMode = proofMode;
    } else if (step === 3) {
      if (!val)           { showErr('What word should people comment to receive this?'); inp.focus(); return; }
      if (val.includes(' ')) { showErr('The keyword must be a single word — no spaces.'); inp.focus(); return; }
      answers.keyword = val.toUpperCase();
    }

    addUser(val);
    step++;

    if (step < QUESTIONS.length) {
      setTimeout(() => {
        addBot(QUESTIONS[step].text, step === 2);
        setInput(QUESTIONS[step], PLACEHOLDERS[step]);
      }, 300);
    } else {
      $inputRow().style.display = 'none';
      const btn = $genBtn();
      if (btn) { btn.style.display = ''; btn.addEventListener('click', triggerLmGenerate, { once: true }); }
    }
  }

  async function triggerLmGenerate() {
    const btn    = $genBtn();
    const errEl  = $genErr();
    if (btn)   { btn.disabled = true; btn.textContent = 'Writing your lead magnet…'; }
    if (errEl)   errEl.style.display = 'none';

    showProcessingScreen(answers.resourceName || '', 'lead_magnet');

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 90_000);

    try {
      const res = await fetch('/api/generate', {
        method:  'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          post_type:          'lead_magnet',
          lead_magnet_inputs: {
            resourceName: answers.resourceName,
            deliverables: answers.deliverables,
            proof:        answers.proof,
            keyword:      answers.keyword,
            proofMode:    answers.proofMode || 'metric',
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'generation_failed');

      finaliseProcessingSteps(data);
      await sleep(600);
      window.location.href = `/editor/${encodeURIComponent(data.id)}`;

    } catch (err) {
      clearTimeout(timeoutId);
      hideProcessingScreen();
      if (btn)  { btn.disabled = false; btn.textContent = 'Write my lead magnet →'; }

      const msg = err.name === 'AbortError'      ? 'This is taking too long. Please try again.'
        : err.message === 'plan_limit_exceeded'  ? 'You\'ve reached the generation limit. <a href="/billing.html">Upgrade →</a>'
        : err.message === 'missing_keyword'      ? 'Keyword missing from generated post. Try regenerating.'
        : 'Something went wrong. Please try again.';
      if (errEl) { errEl.innerHTML = msg; errEl.style.display = ''; }
    }
  }

  function init() {
    step      = 0;
    answers   = {};
    proofMode = 'metric';

    $thread().innerHTML = '';
    const inputRow = $inputRow();
    if (inputRow) inputRow.style.display = '';
    const btn = $genBtn();
    if (btn) btn.style.display = 'none';

    // Re-wire listeners by cloning to drop old handlers
    const oldSend = $send();
    const oldInp  = $input();
    if (oldSend) {
      const ns = oldSend.cloneNode(true);
      oldSend.parentNode.replaceChild(ns, oldSend);
      ns.addEventListener('click', advance);
    }
    if (oldInp) {
      const ni = oldInp.cloneNode(true);
      oldInp.parentNode.replaceChild(ni, oldInp);
      ni.addEventListener('keydown', e => {
        const ml = QUESTIONS[step]?.multiline;
        if (e.key === 'Enter' && (!ml || e.metaKey || e.ctrlKey)) { e.preventDefault(); advance(); }
      });
      ni.addEventListener('input', () => {
        ni.style.height = 'auto';
        ni.style.height = ni.scrollHeight + 'px';
      });
      if (_pendingPrefill) { ni.value = _pendingPrefill; _pendingPrefill = null; }
      ni.focus();
    }

    addBot(QUESTIONS[0].text, false);
    setInput(QUESTIONS[0], PLACEHOLDERS[0]);
  }

  function prefillResourceName(title) {
    _pendingPrefill = title;
    const inp = $input();
    if (inp && step === 0) inp.value = title;
  }

  return { init, prefillResourceName };
})();

/* ── Input error helpers ─────────────────────────────────────── */
function showInputError(msg) {
  ideaInput.classList.add('error');
  ideaError.textContent = msg;
  ideaError.classList.add('visible');
}
function clearInputError() {
  ideaInput.classList.remove('error');
  ideaError.classList.remove('visible');
  generateError.classList.remove('visible');
  substanceWarning.classList.remove('visible');
}
function showGenerateError(html) {
  generateError.innerHTML = html;
  generateError.classList.add('visible');
  generateError.querySelector('a[href="#"]')?.addEventListener('click', e => { e.preventDefault(); triggerGenerate(); });
}
function showSubstanceWarning(msg) {
  substanceWarningTx.textContent = msg;
  substanceWarning.classList.add('visible');
}

/* ── Init ────────────────────────────────────────────────────── */
(async function init() {
  await window.scouthookAuthReady;
  await Promise.all([loadProfile(), loadMixRecommendation()]);

  const urlParams = new URLSearchParams(location.search);
  const urlType   = urlParams.get('type');
  const urlIdea   = urlParams.get('idea');

  if (urlType && TYPE_LABELS[urlType]) {
    if (urlIdea) {
      selectedVaultIdea = null;
      selectType(urlType);
      ideaInput.value = urlIdea;
      ideaInput.dispatchEvent(new Event('input'));
    } else {
      selectType(urlType);
    }
  } else if (urlIdea) {
    selectType('freewrite');
    ideaInput.value = urlIdea;
    ideaInput.dispatchEvent(new Event('input'));
  }
})();

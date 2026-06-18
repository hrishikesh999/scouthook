'use strict';

/* ============================================================
   settings.js — Voice Profile Wizard
   7 stages: Basics · Content Pillars · Credibility · CTAs · Rules · LinkedIn · Samples
   ============================================================ */

async function init() {

  await window.scouthookAuthReady;

  const uid = getUserId();

  /* ── Helpers ────────────────────────────────────────────── */

  function qs(id) { return document.getElementById(id); }

  function safeParseJSON(val, fallback) {
    try { return val ? JSON.parse(val) : fallback; } catch { return fallback; }
  }

  function showStatus(el, msg, isError = false) {
    if (!el) return;
    el.textContent = msg;
    el.className = 'vw-save-status' + (isError ? ' vw-save-status--error' : ' vw-save-status--ok');
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 3000);
  }

  /* ── Chip list builder ──────────────────────────────────── */
  // Sets up a removable chip list in a container. Call ONCE per list.
  // Returns a render() function — call it to refresh the display after mutations.
  // items: string[] (mutated in-place on remove)
  // onChange: (items: string[]) => void — called when list changes
  function makeChipList(containerId, items, onChange) {
    const container = qs(containerId);
    if (!container) return () => {};

    function render() {
      container.innerHTML = '';
      if (items.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'vw-chips-empty';
        empty.textContent = 'None added yet.';
        container.appendChild(empty);
        return;
      }
      items.forEach((item, i) => {
        const chip = document.createElement('span');
        chip.className = 'vw-chip';
        chip.innerHTML = `<span class="vw-chip-text">${escapeHtml(item)}</span>
          <button class="vw-chip-remove" aria-label="Remove" data-index="${i}" type="button">×</button>`;
        container.appendChild(chip);
      });
    }

    // Register listener exactly once — not on every render call
    container.addEventListener('click', e => {
      const btn = e.target.closest('.vw-chip-remove');
      if (!btn) return;
      const idx = Number(btn.dataset.index);
      items.splice(idx, 1);
      render();
      onChange(items);
    });

    render();
    return render;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── Wire an add-chip input + button ───────────────────── */
  function wireAddChip(inputId, btnId, items, renderFn) {
    const input = qs(inputId);
    const btn   = qs(btnId);
    if (!input || !btn) return;

    function tryAdd() {
      const val = input.value.trim();
      if (!val || items.includes(val)) return;
      items.push(val);
      input.value = '';
      renderFn(items);
    }

    btn.addEventListener('click', tryAdd);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); tryAdd(); }
    });
  }

  /* ── Multi-select dropdown ──────────────────────────────── */
  function wireMultiSelect(triggerId, menuId, chipsId, items, options, maxSelections) {
    const trigger        = qs(triggerId);
    const menu           = qs(menuId);
    const chipsContainer = qs(chipsId);
    if (!trigger || !menu || !chipsContainer) return;

    const optionsDiv = menu.querySelector('.vw-multiselect-options');

    // Build checkbox options
    options.forEach(opt => {
      const label = document.createElement('label');
      label.className = 'vw-multiselect-option';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = opt;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + opt));
      optionsDiv.appendChild(label);
    });

    function updateDisplay() {
      // Update trigger label
      const placeholder = trigger.querySelector('.vw-multiselect-placeholder, .vw-multiselect-count');
      if (items.length === 0) {
        placeholder.className = 'vw-multiselect-placeholder';
        placeholder.textContent = 'Select traits…';
      } else {
        placeholder.className = 'vw-multiselect-count';
        placeholder.textContent = items.length + ' selected';
      }

      // Sync checkbox checked/disabled states
      optionsDiv.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = items.includes(cb.value);
        const lbl = cb.closest('.vw-multiselect-option');
        const atLimit = items.length >= maxSelections && !cb.checked;
        lbl.classList.toggle('vw-multiselect-option--disabled', atLimit);
        cb.disabled = atLimit;
      });

      // Render chips
      chipsContainer.innerHTML = '';
      if (items.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'vw-chips-empty';
        empty.textContent = 'None selected.';
        chipsContainer.appendChild(empty);
        return;
      }
      items.forEach((item, i) => {
        const chip = document.createElement('span');
        chip.className = 'vw-chip';
        chip.innerHTML = `<span class="vw-chip-text">${escapeHtml(item)}</span>
          <button class="vw-chip-remove" aria-label="Remove ${escapeHtml(item)}" data-index="${i}" type="button">×</button>`;
        chipsContainer.appendChild(chip);
      });
    }

    // Toggle dropdown open/close
    trigger.addEventListener('click', () => {
      const isOpen = !menu.hidden;
      menu.hidden = isOpen;
      trigger.setAttribute('aria-expanded', String(!isOpen));
    });

    // Close when clicking outside
    document.addEventListener('click', e => {
      if (!trigger.closest('.vw-multiselect').contains(e.target)) {
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
      }
    });

    // Checkbox change
    optionsDiv.addEventListener('change', e => {
      const cb = e.target;
      if (cb.type !== 'checkbox') return;
      if (cb.checked) {
        if (items.length >= maxSelections) { cb.checked = false; return; }
        items.push(cb.value);
      } else {
        const idx = items.indexOf(cb.value);
        if (idx > -1) items.splice(idx, 1);
      }
      updateDisplay();
    });

    // Chip remove button
    chipsContainer.addEventListener('click', e => {
      const btn = e.target.closest('.vw-chip-remove');
      if (!btn) return;
      const idx = Number(btn.dataset.index);
      items.splice(idx, 1);
      updateDisplay();
    });

    updateDisplay();
  }

  /* ── Profile save helper ────────────────────────────────── */
  async function saveProfile(payload) {
    const res = await fetch('/api/profile', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify(payload),
    });
    return res.json();
  }

  /* ── Load profile ───────────────────────────────────────── */
  let profile = {};
  try {
    const r = await fetch('/api/profile/' + encodeURIComponent(uid), { headers: apiHeaders() });
    const d = await r.json();
    profile  = d.profile || {};
  } catch { /* use empty profile */ }

  /* ── Completion bar ─────────────────────────────────────── */
  function updateCompletionBar(pct) {
    const fill   = qs('vw-completion-fill');
    const label  = qs('vw-completion-label');
    const pctEl  = qs('vw-completion-pct');
    if (fill)  fill.style.width    = `${pct}%`;
    if (pctEl) pctEl.textContent   = `${pct}%`;
    if (label) {
      if (pct === 100) {
        label.textContent = 'Your voice profile is complete — posts will sound just like you ✓';
      } else if (pct >= 70) {
        label.textContent = 'Almost there — a couple more stages will sharpen your posts significantly';
      } else if (pct >= 30) {
        label.textContent = 'Good progress — keep going to unlock your full voice quality';
      } else {
        label.textContent = 'Fill in more stages to improve post quality';
      }
    }
  }
  updateCompletionBar(profile.voice_profile_completion_pct || 0);

  /* ── Voice summary panel ────────────────────────────────── */
  function renderVoiceSummary(fp) {
    const panel     = qs('vw-voice-summary');
    const container = qs('vw-voice-traits');
    if (!panel || !container) return;

    // Build trait cards from extracted fingerprint dimensions
    const traits = [];
    if (fp.sentence_rhythm || fp.sentence_tendency) {
      traits.push({
        label: 'Sentence rhythm',
        value: fp.sentence_rhythm || (fp.sentence_tendency === 'short/punchy'
          ? 'Short, punchy sentences'
          : fp.sentence_tendency === 'long-form' ? 'Long-form sentences' : 'Mixed rhythm'),
      });
    }
    if (fp.argument_structure) {
      const labels = {
        'conclusion-first':    'Leads with the conclusion, then explains',
        'build-to-conclusion': 'Builds context before landing the point',
        'problem-then-solution':'Opens with the problem, then the fix',
        'story-then-lesson':   'Tells the story, then draws the lesson',
      };
      traits.push({ label: 'How you argue', value: labels[fp.argument_structure] || fp.argument_structure });
    }
    if (fp.vocabulary_tier) {
      const labels = {
        'technical/jargon':      'Technical — you use industry language',
        'everyday/plain':        'Plain English — no jargon',
        'formal/academic':       'Formal — measured and precise',
        'casual/conversational': 'Conversational — like talking to a colleague',
      };
      traits.push({ label: 'Vocabulary', value: labels[fp.vocabulary_tier] || fp.vocabulary_tier });
    }
    if (fp.opening_move) {
      traits.push({ label: 'How you open', value: fp.opening_move });
    }
    if (fp.tone) {
      traits.push({ label: 'Tone', value: fp.tone });
    }

    if (traits.length === 0) return;

    container.innerHTML = traits.map(t => `
      <div class="vw-voice-trait">
        <span class="vw-voice-trait-label">${escapeHtml(t.label)}</span>
        <span class="vw-voice-trait-value">${escapeHtml(t.value)}</span>
      </div>`).join('');

    panel.hidden = false;
  }

  const fp = safeParseJSON(profile.voice_fingerprint, {});
  if (fp && (fp.sentence_rhythm || fp.argument_structure || fp.vocabulary_tier || fp.opening_move || fp.tone)) {
    renderVoiceSummary(fp);
  }

  // Check which stages have content and mark them
  function updateStageChecks(bv, audience, pillars, statements, ctas, principles, hasLinkedIn, samples) {
    if (bv)                      { const el = qs('vw-check-1'); if (el) el.hidden = false; }
    if (audience)                { const el = qs('vw-check-2'); if (el) el.hidden = false; }
    if (pillars.length > 0)      { const el = qs('vw-check-3'); if (el) el.hidden = false; }
    if (statements.length > 0)   { const el = qs('vw-check-4'); if (el) el.hidden = false; }
    if (ctas.length > 0)         { const el = qs('vw-check-5'); if (el) el.hidden = false; }
    if (principles.length > 0)   { const el = qs('vw-check-6'); if (el) el.hidden = false; }
    if (hasLinkedIn)             { const el = qs('vw-check-7'); if (el) el.hidden = false; }
    if (samples)                 { const el = qs('vw-check-8'); if (el) el.hidden = false; }
  }

  /* ── Stage 1: Brand Voice ────────────────────────────────── */

  // Website URL (stays on profiles table)
  const websiteEl = qs('profile-website');
  if (websiteEl && profile.website_url) websiteEl.value = profile.website_url;

  // ── Brand Voice — chip lists ───────────────────────────────────
  let bvTraits  = safeParseJSON(profile.brand_personality_traits, []);
  let bvPhrases = safeParseJSON(profile.brand_phrases_to_use, []);

  const PERSONALITY_TRAITS = [
    'Authoritative','Bold','Calm','Caring','Confident','Creative',
    'Direct','Empathetic','Energetic','Friendly','Fun','Helpful',
    'Honest','Inspirational','Playful','Professional','Quirky',
    'Rebellious','Reliable','Sophisticated','Warm',
  ];

  wireMultiSelect('bv-traits-trigger', 'bv-traits-menu', 'bv-traits-chips', bvTraits, PERSONALITY_TRAITS, 5);

  const renderBvPhrases = makeChipList('bv-phrases-chips', bvPhrases, () => {});
  wireAddChip('bv-phrases-input', 'bv-phrases-add', bvPhrases, renderBvPhrases);

  // ── Brand Voice — populate Step 1 fields ──────────────────────
  if (qs('bv-description') && profile.brand_description) qs('bv-description').value = profile.brand_description;
  if (qs('bv-industry')    && profile.brand_industry)    qs('bv-industry').value    = profile.brand_industry;

  // ── Brand Voice — populate Step 2 fields ──────────────────────
  if (qs('bv-elevator')  && profile.elevator_main_result)  qs('bv-elevator').value  = profile.elevator_main_result;
  if (qs('bv-mechanism') && profile.elevator_mechanism)    qs('bv-mechanism').value = profile.elevator_mechanism;
  if (qs('bv-archetype') && profile.brand_archetype)       qs('bv-archetype').value = profile.brand_archetype;
  if (qs('bv-tone')      && profile.brand_emotional_tone)  qs('bv-tone').value      = profile.brand_emotional_tone;
  if (qs('bv-origin')    && profile.brand_story_origin)    qs('bv-origin').value    = profile.brand_story_origin;
  if (qs('bv-beliefs') && profile.brand_core_beliefs) {
    const arr = safeParseJSON(profile.brand_core_beliefs, []);
    qs('bv-beliefs').value = arr.join('\n');
  }

  // Show Step 2 immediately if already populated (returning user)
  const bvStep2HasContent = profile.elevator_main_result || profile.elevator_mechanism
    || profile.brand_archetype || profile.brand_emotional_tone || profile.brand_core_beliefs
    || profile.brand_story_origin || bvPhrases.length > 0;
  if (bvStep2HasContent && qs('bv-step-2')) qs('bv-step-2').hidden = false;

  function updateBvStepIndicator(activeStep) {
    const stp1      = qs('bv-stp-1');
    const stp2      = qs('bv-stp-2');
    const connector = qs('bv-stp-connector');
    const circle1   = qs('bv-stp-1-circle');
    const step1div  = qs('bv-step-1');
    const step2div  = qs('bv-step-2');
    if (!stp1 || !stp2) return;
    if (activeStep === 2) {
      stp1.className      = 'bv-stp bv-stp--done';
      if (circle1) circle1.textContent = '✓';
      if (connector) connector.classList.add('bv-stp-connector--done');
      stp2.className      = 'bv-stp bv-stp--active';
      if (step1div) step1div.hidden = true;
      if (step2div) step2div.hidden = false;
    } else {
      stp1.className      = 'bv-stp bv-stp--active';
      if (circle1) circle1.textContent = '1';
      if (connector) connector.classList.remove('bv-stp-connector--done');
      stp2.className      = 'bv-stp bv-stp--pending';
      if (step1div) step1div.hidden = false;
      if (step2div) step2div.hidden = true;
    }
  }

  updateBvStepIndicator(bvStep2HasContent ? 2 : 1);

  qs('bv-stp-1')?.addEventListener('click', () => {
    if (qs('bv-stp-1')?.classList.contains('bv-stp--done')) updateBvStepIndicator(1);
  });

  // ── Brand Voice — Generate Step 2 ─────────────────────────────
  qs('bv-generate-btn')?.addEventListener('click', async () => {
    const btn = qs('bv-generate-btn');
    const statusEl = qs('bv-generate-status');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    // Save Step 1 first so AI reads from DB
    const step1Payload = {
      brand_description:        qs('bv-description')?.value.trim() || null,
      brand_industry:           qs('bv-industry')?.value.trim()    || null,
      brand_personality_traits: bvTraits.length > 0 ? JSON.stringify(bvTraits) : null,
    };
    try {
      await saveProfile(step1Payload);
      const r = await fetch('/api/profile/brand-voice/generate', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ mode: 'prefill' }),
      });
      const d = await r.json();
      if (d.ok && d.prefill) {
        const p = d.prefill;
        if (qs('bv-elevator')  && p.elevator_main_result) qs('bv-elevator').value  = p.elevator_main_result;
        if (qs('bv-mechanism') && p.elevator_mechanism)   qs('bv-mechanism').value = p.elevator_mechanism;
        if (qs('bv-archetype') && p.brand_archetype)      qs('bv-archetype').value = p.brand_archetype;
        if (qs('bv-tone')      && p.brand_emotional_tone) qs('bv-tone').value      = p.brand_emotional_tone;
        if (qs('bv-origin')    && p.brand_story_origin)   qs('bv-origin').value    = p.brand_story_origin;
        if (qs('bv-beliefs') && Array.isArray(p.brand_core_beliefs) && p.brand_core_beliefs.length) {
          qs('bv-beliefs').value = p.brand_core_beliefs.join('\n');
        }
        if (Array.isArray(p.brand_phrases_to_use) && p.brand_phrases_to_use.length) {
          p.brand_phrases_to_use.forEach(ph => { if (!bvPhrases.includes(ph)) bvPhrases.push(ph); });
          renderBvPhrases(bvPhrases);
        }
        updateBvStepIndicator(2);
        qs('bv-step-2')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        showStatus(statusEl, 'Step 2 ready — review and save');
      } else {
        showStatus(statusEl, 'Generation failed — try again', true);
      }
    } catch {
      showStatus(statusEl, 'Generation failed — try again', true);
    }
    btn.textContent = 'Save & Next →';
    btn.disabled = false;
  });

  // ── Brand Voice — Regenerate elevator pitch ───────────────────
  qs('bv-elevator-generate')?.addEventListener('click', async () => {
    const btn = qs('bv-elevator-generate');
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await fetch('/api/profile/generate-positioning', {
        method: 'POST', headers: apiHeaders(),
        body: JSON.stringify({
          brand_description:   qs('bv-description')?.value.trim() || '',
          audience_description: qs('aud-description')?.value.trim() || '',
        }),
      });
      const d = await r.json();
      if (d.ok && d.elevator_main_result && qs('bv-elevator')) {
        qs('bv-elevator').value = d.elevator_main_result;
      }
    } catch { /* silent */ }
    btn.textContent = '✦ Regenerate'; btn.disabled = false;
  });

  // ── Brand Voice — Save ────────────────────────────────────────
  qs('bv-save-btn')?.addEventListener('click', async () => {
    const btn = qs('bv-save-btn');
    const statusEl = qs('bv-save-status');
    btn.disabled = true; btn.textContent = 'Saving…';
    const beliefsLines = (qs('bv-beliefs')?.value || '').split('\n').map(l => l.trim()).filter(Boolean);
    const payload = {
      brand_description:        qs('bv-description')?.value.trim()  || null,
      brand_industry:           qs('bv-industry')?.value.trim()     || null,
      brand_personality_traits: bvTraits.length  > 0 ? JSON.stringify(bvTraits)  : null,
      brand_emotional_tone:     qs('bv-tone')?.value                || null,
      elevator_main_result:     qs('bv-elevator')?.value.trim()     || null,
      elevator_mechanism:       qs('bv-mechanism')?.value.trim()    || null,
      brand_archetype:          qs('bv-archetype')?.value           || null,
      brand_core_beliefs:       beliefsLines.length > 0 ? JSON.stringify(beliefsLines) : null,
      brand_phrases_to_use:     bvPhrases.length > 0 ? JSON.stringify(bvPhrases) : null,
      brand_story_origin:       qs('bv-origin')?.value.trim()       || null,
    };
    try {
      const d = await saveProfile(payload);
      if (d.ok) {
        // Fire final AI generation to cache brand_voice_profile_json
        fetch('/api/profile/brand-voice/generate', {
          method: 'POST', headers: apiHeaders(),
          body: JSON.stringify({ mode: 'final' }),
        }).catch(() => {});
        showStatus(statusEl, 'Brand voice saved ✓');
        const check = qs('vw-check-1');
        if (check) check.hidden = false;
      } else {
        showStatus(statusEl, 'Save failed', true);
      }
    } catch {
      showStatus(statusEl, 'Save failed', true);
    }
    btn.textContent = 'Save brand voice →'; btn.disabled = false;
  });

  /* ── Stage 2: Target Audience ───────────────────────────── */

  let audGoals     = safeParseJSON(profile.audience_goals, []);
  let audObstacles = safeParseJSON(profile.audience_obstacles, []);
  let audBeliefs   = safeParseJSON(profile.audience_core_beliefs_market, []);

  const renderAudGoals     = makeChipList('aud-goals-chips',     audGoals,     () => {});
  const renderAudObstacles = makeChipList('aud-obstacles-chips', audObstacles, () => {});
  const renderAudBeliefs   = makeChipList('aud-beliefs-chips',   audBeliefs,   () => {});
  wireAddChip('aud-goals-input',     'aud-goals-add',     audGoals,     renderAudGoals);
  wireAddChip('aud-obstacles-input', 'aud-obstacles-add', audObstacles, renderAudObstacles);
  wireAddChip('aud-beliefs-input',   'aud-beliefs-add',   audBeliefs,   renderAudBeliefs);

  if (qs('aud-description') && profile.audience_description) qs('aud-description').value = profile.audience_description;
  if (qs('aud-buying-stage')   && profile.audience_buying_stage)          qs('aud-buying-stage').value   = profile.audience_buying_stage;
  if (qs('aud-sophistication') && profile.audience_market_sophistication) qs('aud-sophistication').value = profile.audience_market_sophistication;

  const audStep2HasContent = profile.audience_buying_stage || profile.audience_market_sophistication
    || audBeliefs.length > 0;

  function updateAudStepIndicator(activeStep) {
    const stp1      = qs('aud-stp-1');
    const stp2      = qs('aud-stp-2');
    const connector = qs('aud-stp-connector');
    const circle1   = qs('aud-stp-1-circle');
    const step1div  = qs('aud-step-1');
    const step2div  = qs('aud-step-2');
    if (!stp1 || !stp2) return;
    if (activeStep === 2) {
      stp1.className      = 'bv-stp bv-stp--done';
      if (circle1) circle1.textContent = '✓';
      if (connector) connector.classList.add('bv-stp-connector--done');
      stp2.className      = 'bv-stp bv-stp--active';
      if (step1div) step1div.hidden = true;
      if (step2div) step2div.hidden = false;
    } else {
      stp1.className      = 'bv-stp bv-stp--active';
      if (circle1) circle1.textContent = '1';
      if (connector) connector.classList.remove('bv-stp-connector--done');
      stp2.className      = 'bv-stp bv-stp--pending';
      if (step1div) step1div.hidden = false;
      if (step2div) step2div.hidden = true;
    }
  }
  updateAudStepIndicator(audStep2HasContent ? 2 : 1);

  qs('aud-stp-1')?.addEventListener('click', () => {
    if (qs('aud-stp-1')?.classList.contains('bv-stp--done')) updateAudStepIndicator(1);
  });

  qs('aud-generate-btn')?.addEventListener('click', async () => {
    const btn = qs('aud-generate-btn');
    const statusEl = qs('aud-generate-status');
    btn.disabled = true; btn.textContent = 'Generating…';

    const step1Payload = {
      audience_description: qs('aud-description')?.value.trim() || null,
      audience_goals:       audGoals.length     > 0 ? JSON.stringify(audGoals)     : null,
      audience_obstacles:   audObstacles.length > 0 ? JSON.stringify(audObstacles) : null,
    };
    try {
      await saveProfile(step1Payload);
      const r = await fetch('/api/profile/audience/generate', {
        method: 'POST', headers: apiHeaders(),
        body: JSON.stringify({ mode: 'prefill' }),
      });
      const d = await r.json();
      if (d.ok && d.prefill) {
        const p = d.prefill;
        if (qs('aud-buying-stage')   && p.audience_buying_stage)          qs('aud-buying-stage').value   = p.audience_buying_stage;
        if (qs('aud-sophistication') && p.audience_market_sophistication) qs('aud-sophistication').value = p.audience_market_sophistication;
        if (Array.isArray(p.audience_core_beliefs_market) && p.audience_core_beliefs_market.length) {
          p.audience_core_beliefs_market.forEach(b => { if (!audBeliefs.includes(b)) audBeliefs.push(b); });
          renderAudBeliefs(audBeliefs);
        }
        updateAudStepIndicator(2);
        qs('aud-step-2')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        showStatus(statusEl, 'Step 2 ready — review and save');
      } else {
        showStatus(statusEl, 'Generation failed — try again', true);
      }
    } catch {
      showStatus(statusEl, 'Generation failed — try again', true);
    }
    btn.textContent = 'Save & Next →'; btn.disabled = false;
  });

  qs('aud-save-btn')?.addEventListener('click', async () => {
    const btn = qs('aud-save-btn');
    const statusEl = qs('aud-save-status');
    btn.disabled = true; btn.textContent = 'Saving…';
    const payload = {
      audience_description:           qs('aud-description')?.value.trim() || null,
      audience_goals:                 audGoals.length     > 0 ? JSON.stringify(audGoals)     : null,
      audience_obstacles:             audObstacles.length > 0 ? JSON.stringify(audObstacles) : null,
      audience_core_beliefs_market:   audBeliefs.length   > 0 ? JSON.stringify(audBeliefs)   : null,
      audience_buying_stage:          qs('aud-buying-stage')?.value   || null,
      audience_market_sophistication: qs('aud-sophistication')?.value || null,
    };
    try {
      const d = await saveProfile(payload);
      if (d.ok) {
        fetch('/api/profile/audience/generate', {
          method: 'POST', headers: apiHeaders(),
          body: JSON.stringify({ mode: 'final' }),
        }).catch(() => {});
        showStatus(statusEl, 'Audience profile saved ✓');
        const check = qs('vw-check-2');
        if (check) check.hidden = false;
      } else {
        showStatus(statusEl, 'Save failed', true);
      }
    } catch {
      showStatus(statusEl, 'Save failed', true);
    }
    btn.textContent = 'Save audience profile →'; btn.disabled = false;
  });

  /* ── Stage 3: Content Pillars ───────────────────────────── */
  // Migration shim: if content_pillars is empty but content_themes has data, seed from themes
  let rawPillars = profile.content_pillars;
  if (!rawPillars || rawPillars === '[]') {
    const legacyThemes = safeParseJSON(profile.content_themes, []);
    if (legacyThemes.length > 0) rawPillars = profile.content_themes;
  }
  let pillars = safeParseJSON(rawPillars, []);

  const renderPillars = makeChipList('vw-pillars-chips', pillars, () => {});
  wireAddChip('vw-pillars-input', 'vw-pillars-add', pillars, renderPillars);

  // Suggest pillars button
  const pillarsBtn = qs('vw-pillars-suggest');
  if (pillarsBtn) {
    pillarsBtn.addEventListener('click', async () => {
      pillarsBtn.textContent = 'Thinking…';
      pillarsBtn.disabled = true;
      try {
        const r = await fetch('/api/profile/generate-content-pillars', {
          method: 'POST', headers: apiHeaders(), body: '{}',
        });
        const d = await r.json();
        if (d.ok && d.content_pillars) {
          let incoming = [];
          try { incoming = JSON.parse(d.content_pillars); } catch { /* ignore */ }
          incoming.forEach(p => { if (!pillars.includes(p)) pillars.push(p); });
          renderPillars(pillars);
          pillarsBtn.textContent = 'Suggestions added ✓';
        } else {
          pillarsBtn.textContent = '✦ Suggest pillars from my profile';
        }
      } catch {
        pillarsBtn.textContent = '✦ Suggest pillars from my profile';
      }
      pillarsBtn.disabled = false;
    });
  }

  // Save pillars
  qs('vw-pillars-save')?.addEventListener('click', async () => {
    const btn = qs('vw-pillars-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const d = await saveProfile({ content_pillars: JSON.stringify(pillars) });
      if (d.ok) {
        showStatus(qs('vw-pillars-status'), 'Saved ✓');
        if (pillars.length > 0) { const el = qs('vw-check-3'); if (el) el.hidden = false; }
      } else {
        showStatus(qs('vw-pillars-status'), 'Save failed', true);
      }
    } catch {
      showStatus(qs('vw-pillars-status'), 'Save failed', true);
    }
    btn.textContent = 'Save pillars →';
    btn.disabled = false;
  });

  /* ── Stage 4: Authority Statements ─────────────────────── */
  let statements = safeParseJSON(profile.authority_statements, []);

  const renderStatements = makeChipList('vw-authority-chips', statements, () => {});
  wireAddChip('vw-authority-input', 'vw-authority-add', statements, renderStatements);

  qs('vw-authority-save')?.addEventListener('click', async () => {
    const btn = qs('vw-authority-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const d = await saveProfile({ authority_statements: JSON.stringify(statements) });
      if (d.ok) {
        showStatus(qs('vw-authority-status'), 'Saved ✓');
        if (statements.length > 0) { const el = qs('vw-check-4'); if (el) el.hidden = false; }
      } else {
        showStatus(qs('vw-authority-status'), 'Save failed', true);
      }
    } catch {
      showStatus(qs('vw-authority-status'), 'Save failed', true);
    }
    btn.textContent = 'Save statements →';
    btn.disabled = false;
  });

  /* ── Stage 5: CTA Library ──────────────────────────────── */
  let ctas = safeParseJSON(profile.cta_library, []);

  const renderCTAs = makeChipList('vw-cta-chips', ctas, () => {});
  wireAddChip('vw-cta-input', 'vw-cta-add', ctas, renderCTAs);

  // Suggested CTA pills
  document.querySelectorAll('.vw-cta-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const val = pill.dataset.cta;
      if (val && !ctas.includes(val)) {
        ctas.push(val);
        renderCTAs(ctas);
        pill.disabled = true;
        pill.classList.add('vw-cta-pill--added');
      }
    });
  });

  qs('vw-cta-save')?.addEventListener('click', async () => {
    const btn = qs('vw-cta-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const d = await saveProfile({ cta_library: JSON.stringify(ctas) });
      if (d.ok) {
        showStatus(qs('vw-cta-status'), 'Saved ✓');
        if (ctas.length > 0) { const el = qs('vw-check-5'); if (el) el.hidden = false; }
      } else {
        showStatus(qs('vw-cta-status'), 'Save failed', true);
      }
    } catch {
      showStatus(qs('vw-cta-status'), 'Save failed', true);
    }
    btn.textContent = 'Save CTAs →';
    btn.disabled = false;
  });

  /* ── Stage 6: Content Principles ───────────────────────── */
  let principles = safeParseJSON(profile.content_principles, []);

  const renderPrinciples = makeChipList('vw-principles-chips', principles, () => {});
  wireAddChip('vw-principles-input', 'vw-principles-add', principles, renderPrinciples);

  qs('vw-principles-save')?.addEventListener('click', async () => {
    const btn = qs('vw-principles-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const d = await saveProfile({ content_principles: JSON.stringify(principles) });
      if (d.ok) {
        showStatus(qs('vw-principles-status'), 'Saved ✓');
        if (principles.length > 0) { const el = qs('vw-check-6'); if (el) el.hidden = false; }
      } else {
        showStatus(qs('vw-principles-status'), 'Save failed', true);
      }
    } catch {
      showStatus(qs('vw-principles-status'), 'Save failed', true);
    }
    btn.textContent = 'Save rules →';
    btn.disabled = false;
  });

  /* ── Stage 7: LinkedIn ──────────────────────────────────── */

  // Show LinkedIn profile data in the connected card
  function renderLinkedInProfile(data) {
    const card = qs('vw-linkedin-profile-card');
    if (!card) return;
    const photo    = qs('vw-linkedin-photo');
    const nameEl   = qs('vw-linkedin-name');
    const headlineEl = qs('vw-linkedin-headline');
    if (data.photo_url && photo) {
      photo.src = data.photo_url;
      photo.hidden = false;
    }
    if (data.name && nameEl)       nameEl.textContent = data.name;
    if (data.headline && headlineEl) headlineEl.textContent = data.headline;
    if ((data.name || data.headline) && card) card.hidden = false;
  }

  // Check LinkedIn connection status
  let linkedInData = null;
  try {
    const r = await fetch('/api/linkedin/status', { headers: apiHeaders() });
    const d = await r.json();
    if (d.connected) {
      linkedInData = d;
      qs('vw-linkedin-connected')?.removeAttribute('hidden');
      qs('vw-linkedin-connect')?.setAttribute('hidden', '');
      renderLinkedInProfile(d);
      const el = qs('vw-check-7');
      if (el) el.hidden = false;

      // If redirected back after connect, show a success flash
      if (window.location.search.includes('linkedin_connected=true')) {
        showStatus(qs('vw-linkedin-refresh-status'), 'LinkedIn connected ✓');
        // Clean up the URL param
        const url = new URL(window.location.href);
        url.searchParams.delete('linkedin_connected');
        window.history.replaceState({}, '', url.toString());
      }
    }
  } catch { /* non-fatal — show connect button */ }

  // Refresh profile data button — calls /extract-profile to auto-populate empty fields,
  // then refreshes the LinkedIn profile card display and any Stage 1 fields that changed.
  qs('vw-linkedin-refresh')?.addEventListener('click', async () => {
    const btn = qs('vw-linkedin-refresh');
    btn.disabled = true;
    btn.querySelector('svg')?.classList.add('spin');
    const statusEl = qs('vw-linkedin-refresh-status');
    try {
      const r = await fetch('/api/linkedin/extract-profile', { method: 'POST', headers: apiHeaders() });
      const d = await r.json();
      if (d.ok) {
        // Refresh profile card display
        const statusR = await fetch('/api/linkedin/status', { headers: apiHeaders() });
        const statusD = await statusR.json();
        if (statusD.connected) renderLinkedInProfile(statusD);

        // Update Brand Voice + Audience fields with LinkedIn-sourced values.
        if (d.profile) {
          const fieldMap = {
            'bv-description':  d.profile.brand_description,
            'aud-description': d.profile.audience_description,
            'bv-elevator':     d.profile.elevator_main_result,
          };
          let updatedCount = 0;
          Object.entries(fieldMap).forEach(([elId, val]) => {
            const el = qs(elId);
            if (el && val) {
              const changed = el.value.trim() !== val;
              el.value = val;
              if (changed) updatedCount++;
            }
          });

          // Merge new pillars into the chip list (additive — never remove existing)
          if (d.profile.content_pillars) {
            let incoming = [];
            try { incoming = JSON.parse(d.profile.content_pillars); } catch { /* ignore */ }
            incoming.forEach(p => { if (!pillars.includes(p)) pillars.push(p); });
            renderPillars(pillars);
          }

          const msg = d.updated?.length > 0
            ? `LinkedIn profile synced ✓${updatedCount > 0 ? ` — ${updatedCount} field${updatedCount > 1 ? 's' : ''} updated` : ''}`
            : 'LinkedIn profile already up to date ✓';
          showStatus(statusEl, msg);
        } else {
          showStatus(statusEl, 'LinkedIn profile synced ✓');
        }
      } else {
        showStatus(statusEl, 'Refresh failed', true);
      }
    } catch {
      showStatus(statusEl, 'Refresh failed', true);
    }
    btn.disabled = false;
    btn.querySelector('svg')?.classList.remove('spin');
  });

  /* ── Archetype coaching panel ───────────────────────────── */
  const archetypePanel    = qs('vw-archetype-panel');
  const archetypeCoaching = qs('vw-archetype-coaching');

  const archetypeLabels = {
    CONFESSION:    'Confession',
    BEFORE_AFTER:  'Before & after',
    INSIGHT:       'Insight',
    DIRECT_ADDRESS:'Direct address',
    NUMBER:        'Number hook',
    MYTH_BUST:     'Myth bust',
    CURIOSITY_GAP: 'Curiosity gap',
    REFRAME:       'Reframe',
  };

  const archetypeDescriptions = {
    CONFESSION:    'Leads with a personal mistake or past belief',
    BEFORE_AFTER:  'Contrasts two states side by side',
    INSIGHT:       'States a non-obvious truth as plain fact',
    DIRECT_ADDRESS:'Speaks directly to one specific person',
    NUMBER:        'Opens with a striking number or result',
    MYTH_BUST:     'Names a wrong belief then immediately reverses it',
    CURIOSITY_GAP: 'Withholds the key detail to create a compulsion to read',
    REFRAME:       'Repositions something familiar from an unexpected angle',
  };

  const archetypePrefs = safeParseJSON(profile.user_archetype_preference, {});
  const topArchetypes = Object.entries(archetypePrefs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  if (archetypePanel && archetypeCoaching) {
    if (topArchetypes.length > 0) {
      archetypeCoaching.innerHTML = topArchetypes.map(([key, count], i) => {
        const isTop = i === 0;
        const rankLabels = ['#1 signature', '#2 frequent', '#3 occasional'];
        return `<div class="vw-archetype-card${isTop ? ' vw-archetype-card--top' : ''}">
          <span class="vw-archetype-rank">${rankLabels[i] || '#' + (i + 1)}</span>
          <span class="vw-archetype-name">${escapeHtml(archetypeLabels[key] || key)}</span>
          <span class="vw-archetype-count">${escapeHtml(archetypeDescriptions[key] || '')} · ${count} post${count !== 1 ? 's' : ''}</span>
        </div>`;
      }).join('');
      archetypePanel.hidden = false;
    }
  }

  /* ── Stage 8: Writing Samples (individual cards) ─────────── */
  let samplesData = [];

  function renderSampleCards() {
    const list   = qs('vw-samples-list');
    const addBtn = qs('vw-samples-add');
    if (!list) return;

    list.innerHTML = '';
    samplesData.forEach((text, i) => {
      const card = document.createElement('div');
      card.className = 'vw-sample-card';
      card.innerHTML = `
        <p class="vw-sample-card-label">Sample ${i + 1}</p>
        <button class="vw-sample-card-remove" aria-label="Remove sample" data-index="${i}" type="button">×</button>
        <textarea class="field-textarea vw-sample-textarea" placeholder="Paste a LinkedIn post here…"></textarea>
      `;
      card.querySelector('.vw-sample-textarea').value = text;
      list.appendChild(card);
    });

    if (addBtn) addBtn.disabled = samplesData.length >= 5;
  }

  function addSampleCard(text = '') {
    if (samplesData.length >= 5) return;
    samplesData.push(text);
    renderSampleCards();
  }

  // Remove card listener (event delegation)
  qs('vw-samples-list')?.addEventListener('click', e => {
    const btn = e.target.closest('.vw-sample-card-remove');
    if (!btn) return;
    const idx = Number(btn.dataset.index);
    samplesData.splice(idx, 1);
    renderSampleCards();
    if (samplesData.every(s => !s.trim())) {
      const checkEl = qs('vw-check-8');
      if (checkEl) checkEl.hidden = true;
    }
  });

  qs('vw-samples-add')?.addEventListener('click', () => addSampleCard());

  // Load existing samples data
  {
    const raw = profile.writing_samples || '';
    let loaded = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) loaded = parsed;
      else if (raw) loaded = [raw];
    } catch {
      if (raw) loaded = [raw];
    }
    if (loaded.length === 0) loaded = [''];
    loaded.forEach(t => addSampleCard(t));
  }

  // Save handler
  qs('vw-samples-save')?.addEventListener('click', async () => {
    const btn = qs('vw-samples-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    // Collect current textarea values
    const values = Array.from(document.querySelectorAll('.vw-sample-textarea'))
      .map(t => t.value.trim())
      .filter(Boolean);
    const val = values.length > 0 ? JSON.stringify(values) : null;

    try {
      const d = await saveProfile({ writing_samples: val });
      if (d.ok) {
        showStatus(qs('vw-samples-status'), 'Saved ✓');
        if (val) { const el = qs('vw-check-8'); if (el) el.hidden = false; }
      } else {
        showStatus(qs('vw-samples-status'), 'Save failed', true);
      }
    } catch {
      showStatus(qs('vw-samples-status'), 'Save failed', true);
    }
    btn.textContent = 'Save samples →';
    btn.disabled = false;
  });

  /* ── Stage check marks (initial state) ─────────────────── */
  const bvPopulated       = !!(profile.brand_description || profile.brand_industry || profile.elevator_main_result);
  const audiencePopulated = !!(profile.audience_description || profile.audience_buying_stage);
  const hasLinkedIn = !qs('vw-linkedin-connect') || qs('vw-linkedin-connect').hasAttribute('hidden');
  const hasSamples  = samplesData.some(s => s.trim());
  updateStageChecks(bvPopulated, audiencePopulated, pillars, statements, ctas, principles, hasLinkedIn, hasSamples);

  /* ── Step navigation ────────────────────────────────────── */
  let currentStep = 1;

  function switchToStep(n) {
    if (n < 1 || n > 8) return;

    document.querySelectorAll('.vw-stage-panel').forEach(p => {
      p.classList.remove('vw-stage-panel--active');
    });

    const target = qs('voice-stage-' + n);
    if (target) target.classList.add('vw-stage-panel--active');

    document.querySelectorAll('.vw-stage-link').forEach(a => {
      a.classList.toggle('vw-stage-link--active', a.dataset.stage === String(n));
    });

    currentStep = n;
  }

  function firstIncompleteStep() {
    for (let i = 1; i <= 8; i++) {
      const check = qs('vw-check-' + i);
      if (!check || check.hidden) return i;
    }
    return 1;
  }

  // Wire sidebar link clicks
  document.querySelectorAll('.vw-stage-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      switchToStep(Number(a.dataset.stage));
    });
  });

  // Wire Next buttons
  document.querySelectorAll('.vw-step-next-btn').forEach(btn => {
    btn.addEventListener('click', () => switchToStep(currentStep + 1));
  });

  // Wire Back buttons
  document.querySelectorAll('.vw-step-back-btn').forEach(btn => {
    btn.addEventListener('click', () => switchToStep(currentStep - 1));
  });

  // Wire "Update writing sample" link in voice summary panel
  qs('vw-voice-edit-link')?.addEventListener('click', e => {
    e.preventDefault();
    switchToStep(8);
  });

  // Initial step: honour explicit ?step= param (e.g. from onboarding next-steps links),
  // then linkedin_connected redirect, then first incomplete step
  const stepParam = new URLSearchParams(window.location.search).get('step');
  if (stepParam) {
    const n = parseInt(stepParam, 10);
    if (n >= 1 && n <= 8) {
      switchToStep(n);
    } else {
      switchToStep(firstIncompleteStep());
    }
  } else if (window.location.search.includes('linkedin_connected=true')) {
    switchToStep(7);
  } else {
    switchToStep(firstIncompleteStep());
  }

}

window.__pageInit = init;
window.__pageCleanup = null;
init();

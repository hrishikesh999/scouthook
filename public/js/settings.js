'use strict';

/* ============================================================
   settings.js — Voice Profile Wizard
   7 stages: Basics · Core Themes · Credibility · CTAs · Rules · LinkedIn · Samples
   ============================================================ */

(async () => {

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
    const fill  = qs('vw-completion-fill');
    const label = qs('vw-completion-label');
    if (fill)  fill.style.width  = `${pct}%`;
    if (label) label.textContent = `Voice profile ${pct}% complete`;
  }
  updateCompletionBar(profile.voice_profile_completion_pct || 0);

  // Check which stages have content and mark them
  function updateStageChecks(basics, themes, statements, ctas, principles, hasLinkedIn, samples) {
    if (basics)           { const el = qs('vw-check-1'); if (el) el.hidden = false; }
    if (themes.length > 0)      { const el = qs('vw-check-2'); if (el) el.hidden = false; }
    if (statements.length > 0)  { const el = qs('vw-check-3'); if (el) el.hidden = false; }
    if (ctas.length > 0)        { const el = qs('vw-check-4'); if (el) el.hidden = false; }
    if (principles.length > 0)  { const el = qs('vw-check-5'); if (el) el.hidden = false; }
    if (hasLinkedIn)             { const el = qs('vw-check-6'); if (el) el.hidden = false; }
    if (samples)                 { const el = qs('vw-check-7'); if (el) el.hidden = false; }
  }

  /* ── Stage 1: Profile Basics ────────────────────────────── */
  const basicsFields = {
    'profile-positioning': 'business_positioning',
    'profile-website':     'website_url',
    'profile-niche':       'content_niche',
    'profile-audience':    'audience_role',
    'profile-pain':        'audience_pain',
    'profile-contrarian':  'contrarian_view',
  };

  // Populate basics fields from profile
  Object.entries(basicsFields).forEach(([elId, key]) => {
    const el = qs(elId);
    if (el && profile[key]) el.value = profile[key];
  });

  // Determine if basics has meaningful content
  function basicsHasContent() {
    return Object.keys(basicsFields).some(elId => {
      const el = qs(elId);
      return el && el.value.trim().length > 0;
    });
  }

  qs('vw-basics-save')?.addEventListener('click', async () => {
    const btn = qs('vw-basics-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const payload = {};
    Object.entries(basicsFields).forEach(([elId, key]) => {
      const el = qs(elId);
      if (el) payload[key] = el.value.trim() || null;
    });
    try {
      const d = await saveProfile(payload);
      if (d.ok) {
        showStatus(qs('vw-basics-status'), 'Saved ✓');
        if (basicsHasContent()) { const el = qs('vw-check-1'); if (el) el.hidden = false; }
      } else {
        showStatus(qs('vw-basics-status'), 'Save failed', true);
      }
    } catch {
      showStatus(qs('vw-basics-status'), 'Save failed', true);
    }
    btn.textContent = 'Save basics →';
    btn.disabled = false;
  });

  /* ── Stage 2: Core Themes ───────────────────────────────── */
  let themes = safeParseJSON(profile.content_themes, []);

  const renderThemes = makeChipList('vw-themes-chips', themes, () => {});
  wireAddChip('vw-themes-input', 'vw-themes-add', themes, renderThemes);

  // Suggest themes button
  const suggestBtn = qs('vw-themes-suggest');
  if (suggestBtn) {
    suggestBtn.addEventListener('click', async () => {
      suggestBtn.textContent = 'Thinking…';
      suggestBtn.disabled = true;
      try {
        const r = await fetch('/api/profile/suggest-themes', {
          method: 'POST', headers: apiHeaders(), body: '{}',
        });
        const d = await r.json();
        if (d.ok && Array.isArray(d.themes) && d.themes.length > 0) {
          // Add any suggestions not already in the list
          d.themes.forEach(t => { if (!themes.includes(t)) themes.push(t); });
          renderThemes(themes);
          suggestBtn.textContent = 'Suggestions added ✓';
        } else {
          suggestBtn.textContent = '✦ Suggest themes from my profile';
        }
      } catch {
        suggestBtn.textContent = '✦ Suggest themes from my profile';
      }
      suggestBtn.disabled = false;
    });
  }

  // Save themes
  qs('vw-themes-save')?.addEventListener('click', async () => {
    const btn = qs('vw-themes-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const d = await saveProfile({ content_themes: JSON.stringify(themes) });
      if (d.ok) {
        showStatus(qs('vw-themes-status'), 'Saved ✓');
        if (themes.length > 0) { const el = qs('vw-check-2'); if (el) el.hidden = false; }
      } else {
        showStatus(qs('vw-themes-status'), 'Save failed', true);
      }
    } catch {
      showStatus(qs('vw-themes-status'), 'Save failed', true);
    }
    btn.textContent = 'Save themes →';
    btn.disabled = false;
  });

  /* ── Stage 3: Authority Statements ─────────────────────── */
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
        if (statements.length > 0) { const el = qs('vw-check-3'); if (el) el.hidden = false; }
      } else {
        showStatus(qs('vw-authority-status'), 'Save failed', true);
      }
    } catch {
      showStatus(qs('vw-authority-status'), 'Save failed', true);
    }
    btn.textContent = 'Save statements →';
    btn.disabled = false;
  });

  /* ── Stage 4: CTA Library ──────────────────────────────── */
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
        if (ctas.length > 0) { const el = qs('vw-check-4'); if (el) el.hidden = false; }
      } else {
        showStatus(qs('vw-cta-status'), 'Save failed', true);
      }
    } catch {
      showStatus(qs('vw-cta-status'), 'Save failed', true);
    }
    btn.textContent = 'Save CTAs →';
    btn.disabled = false;
  });

  /* ── Stage 5: Content Principles ───────────────────────── */
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
        if (principles.length > 0) { const el = qs('vw-check-5'); if (el) el.hidden = false; }
      } else {
        showStatus(qs('vw-principles-status'), 'Save failed', true);
      }
    } catch {
      showStatus(qs('vw-principles-status'), 'Save failed', true);
    }
    btn.textContent = 'Save rules →';
    btn.disabled = false;
  });

  /* ── Stage 6: LinkedIn ──────────────────────────────────── */

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
      const el = qs('vw-check-6');
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

  // Refresh profile data button
  qs('vw-linkedin-refresh')?.addEventListener('click', async () => {
    const btn = qs('vw-linkedin-refresh');
    btn.disabled = true;
    btn.querySelector('svg')?.classList.add('spin');
    const statusEl = qs('vw-linkedin-refresh-status');
    try {
      const r = await fetch('/api/linkedin/status', { headers: apiHeaders() });
      const d = await r.json();
      if (d.connected) {
        renderLinkedInProfile(d);
        showStatus(statusEl, 'Profile data refreshed ✓');
      } else {
        showStatus(statusEl, 'Not connected', true);
      }
    } catch {
      showStatus(statusEl, 'Refresh failed', true);
    }
    btn.disabled = false;
    btn.querySelector('svg')?.classList.remove('spin');
  });

  /* ── Stage 7: Writing Samples ───────────────────────────── */
  const samplesEl = qs('profile-samples');
  if (samplesEl && profile.writing_samples) samplesEl.value = profile.writing_samples;

  qs('vw-samples-save')?.addEventListener('click', async () => {
    const btn = qs('vw-samples-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const val = samplesEl?.value.trim() || null;
    try {
      const d = await saveProfile({ writing_samples: val });
      if (d.ok) {
        showStatus(qs('vw-samples-status'), 'Saved ✓');
        if (val) { const el = qs('vw-check-7'); if (el) el.hidden = false; }
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
  const basicsPopulated = Object.keys(basicsFields).some(elId => {
    const el = qs(elId);
    return el && el.value.trim().length > 0;
  });
  const hasLinkedIn = !qs('vw-linkedin-connect') || qs('vw-linkedin-connect').hasAttribute('hidden');
  const hasSamples  = !!(samplesEl?.value.trim());
  updateStageChecks(basicsPopulated, themes, statements, ctas, principles, hasLinkedIn, hasSamples);

  /* ── Hash-based scroll ──────────────────────────────────── */
  function scrollToStage(hash) {
    const target = document.querySelector(hash);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Highlight active stage link
      document.querySelectorAll('.vw-stage-link').forEach(a => {
        a.classList.toggle('vw-stage-link--active', a.getAttribute('href') === hash);
      });
    }
  }

  // Scroll to hash on load (or to stage 6 if just connected LinkedIn)
  if (window.location.search.includes('linkedin_connected=true') && !window.location.hash) {
    setTimeout(() => scrollToStage('#voice-stage-6'), 100);
  } else if (window.location.hash) {
    setTimeout(() => scrollToStage(window.location.hash), 100);
  }

  // Update active link on scroll (IntersectionObserver)
  const panels = document.querySelectorAll('.vw-stage-panel');
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const hash = '#' + entry.target.id;
        document.querySelectorAll('.vw-stage-link').forEach(a => {
          a.classList.toggle('vw-stage-link--active', a.getAttribute('href') === hash);
        });
      }
    });
  }, { threshold: 0.4 });
  panels.forEach(p => observer.observe(p));

})();

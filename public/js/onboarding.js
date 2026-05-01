'use strict';

/* ============================================================
   onboarding.js — Scouthook first-time wizard
   Controls the 6-screen setup flow:
     1. Role + voice profile (combined, with optional website auto-fill)
     3. Generate first post (role-specific chips)
     4a. Archetype reveal + celebration
     4b. Post + quality score
     5. LinkedIn connect (reframed as required for publishing)
     6. Voice deepening + vault hint (optional)
   ============================================================ */

const Onboarding = (() => {

  /* ── Module state ─────────────────────────────────────── */
  const state = {
    role:            null,
    roleCustom:      null,
    websiteUrl:      null,
    postId:          null,
    post:            null,
    quality:         null,
    archetypeUsed:   null,
    hookConfidence:  null,
    currentScreen:   '1',
    suggestionsOpen: false,
  };

  /* ── Role-specific prompt chips ────────────────────────── */
  const ROLE_CHIPS = {
    consultant: [
      'The assumption that cost a client before we worked together',
      'The question I ask at the start of every new engagement',
      'Why most advice in my field sounds right but fails in practice',
    ],
    coach: [
      'The belief that held my best client back the longest',
      'What high performers consistently get wrong about growth',
      'The moment I knew someone was finally ready to change',
    ],
    freelancer: [
      'The project scope conversation I wish I\'d had on day one',
      'What clients say they want versus what they actually need',
      'The pattern I see in every client who outgrows freelancing',
    ],
    founder: [
      'The assumption I had about product-market fit that was completely wrong',
      'What I wish I\'d known about hiring before we made our first mistake',
      'The decision that looks obvious now but wasn\'t at the time',
    ],
    other: [
      'A mistake I made early in my career that taught me everything',
      'The one thing most of my clients get wrong before they hire me',
      'What I wish someone had told me when I started out',
    ],
  };

  /* ── Archetype metadata for reveal + why-hook ──────────── */
  const ARCHETYPE_META = {
    NUMBER:          { desc: 'Opens with a specific number, timeframe, or measurable result', example: '"3 years ago I nearly killed my consulting business."' },
    CONTRARIAN:      { desc: 'Challenges a popular belief directly — no softening language', example: '"Most advice about pricing is wrong."' },
    CONFESSION:      { desc: 'Opens with a personal mistake or failure in the past tense', example: '"I used to think strategy was the hard part."' },
    PATTERN_INTERRUPT: { desc: 'A counterintuitive truth under 8 words — no context given', example: '"Nobody actually wants your expertise."' },
    DIRECT_ADDRESS:  { desc: 'Speaks directly to a specific person in a specific situation', example: '"If you are billing by the hour, read this."' },
    STAKES:          { desc: 'Opens with consequence or cost before cause or context', example: '"This one assumption cost me six months of work."' },
    BEFORE_AFTER:    { desc: 'Two contrasting states that show a transformation', example: '"12 months ago: 200 followers. Today: inbound every week."' },
    INSIGHT:         { desc: 'A clean declarative observation about your field', example: '"The best consultants sell certainty, not strategy."' },
  };

  /* ── Utilities ────────────────────────────────────────── */
  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function qs(id)   { return document.getElementById(id); }
  function qsa(sel) { return document.querySelectorAll(sel); }

  /* ── Screen navigation ────────────────────────────────── */
  function showScreen(id) {
    const key = String(id);
    qsa('.ob-screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(`ob-screen-${key}`);
    if (target) {
      target.classList.add('active');
      state.currentScreen = key;
      window.scrollTo(0, 0);
    }
    updateDots(key);
  }

  function updateDots(screenKey) {
    const dots = qs('ob-step-dots');
    if (!dots) return;
    const dotMap  = { '3': '3', '4b': '4b', '6': '6' };
    const showFor = Object.keys(dotMap);
    dots.hidden = !showFor.includes(screenKey);
    if (!dots.hidden) {
      qsa('.ob-dot').forEach(dot => {
        dot.classList.toggle('active', dot.dataset.step === dotMap[screenKey]);
      });
    }
  }

  /* ── Screen 1: Role + voice profile (combined) ────────── */
  function initScreen1() {
    const cards      = qsa('.ob-role-card');
    const customWrap = qs('ob-role-custom-wrap');
    const voiceFields = qs('ob-voice-fields');
    const ctaBtn     = qs('ob-s2-cta');
    const loadEl     = qs('ob-s2-loading');
    const errorEl    = qs('ob-s2-error');
    const autofillBtn = qs('ob-autofill-btn');
    const autofillLoad = qs('ob-autofill-loading');

    // Role card selection → reveal voice fields
    cards.forEach(card => {
      card.addEventListener('click', () => {
        cards.forEach(c => {
          c.classList.remove('selected');
          c.setAttribute('aria-pressed', 'false');
        });
        card.classList.add('selected');
        card.setAttribute('aria-pressed', 'true');
        state.role = card.dataset.role;

        const isOther = state.role === 'other';
        customWrap.hidden = !isOther;
        if (isOther) qs('ob-role-custom').focus();

        // Slide in voice fields on first role selection
        if (voiceFields.hidden) {
          voiceFields.hidden = false;
          // Trigger CSS transition on next frame
          requestAnimationFrame(() => voiceFields.classList.add('visible'));
          qs('ob-website')?.focus();
        }
      });
    });

    // Website auto-fill
    if (autofillBtn) {
      autofillBtn.addEventListener('click', async () => {
        const url = (qs('ob-website').value || '').trim();
        if (!url || !/^https?:\/\//i.test(url)) {
          qs('ob-website').focus();
          return;
        }
        state.websiteUrl = url;
        autofillBtn.disabled = true;
        autofillLoad.hidden  = false;

        try {
          const res  = await fetch('/api/profile/extract-website', {
            method:  'POST',
            headers: apiHeaders(),
            body:    JSON.stringify({ url }),
          });
          const data = await res.json();
          if (data.ok) {
            if (data.content_niche)  qs('ob-niche').value    = data.content_niche;
            if (data.audience_role)  qs('ob-audience').value = data.audience_role;
            if (data.audience_pain)  { /* stored for Screen 6 pre-fill if desired */ }
            if (data.content_niche || data.audience_role) {
              qs('ob-niche').focus();
            }
          }
        } catch (e) {
          console.error('[onboarding] auto-fill error (non-fatal):', e);
        } finally {
          autofillBtn.disabled = false;
          autofillLoad.hidden  = true;
        }
      });
    }

    // Allow submitting with Enter key on niche/audience fields
    ['ob-niche', 'ob-audience'].forEach(id => {
      const el = qs(id);
      if (el) el.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); ctaBtn?.click(); }
      });
    });

    // CTA: validate + save profile → go to Screen 3
    ctaBtn?.addEventListener('click', async () => {
      if (!state.role) return; // shouldn't happen — CTA only visible after role selected

      if (state.role === 'other') {
        const custom = (qs('ob-role-custom').value || '').trim();
        if (!custom) return;
        state.roleCustom = custom;
      }

      const niche    = (qs('ob-niche').value    || '').trim();
      const audience = (qs('ob-audience').value || '').trim();

      if (!niche || !audience) {
        errorEl.hidden = false;
        (!niche ? qs('ob-niche') : qs('ob-audience')).focus();
        return;
      }
      errorEl.hidden = true;

      ctaBtn.disabled = true;
      loadEl.hidden   = false;

      try {
        const roleValue = state.role === 'other' ? state.roleCustom : state.role;
        const body = {
          content_niche: niche,
          audience_role: audience,
          user_role:     roleValue,
        };
        if (state.websiteUrl) body.website_url = state.websiteUrl;

        const res = await fetch('/api/profile', {
          method:  'POST',
          headers: apiHeaders(),
          body:    JSON.stringify(body),
        });
        if (!res.ok) throw new Error('profile_save_failed');
        populateChips(); // role is set — render role-specific chips before showing screen
        showScreen(3);
      } catch (e) {
        console.error('[onboarding] screen 1 save error:', e);
        errorEl.textContent = 'Something went wrong saving your profile. Please try again.';
        errorEl.hidden = false;
      } finally {
        ctaBtn.disabled = false;
        loadEl.hidden   = true;
      }
    });
  }

  /* ── Screen 3: First post generation ─────────────────── */
  function initScreen3() {
    const ideaEl  = qs('ob-idea');
    const ctaBtn  = qs('ob-s3-cta');
    const errorEl = qs('ob-s3-error');

    // Chip clicks populate and focus the textarea (delegate — chips are rendered at nav time)
    qs('ob-chips')?.addEventListener('click', e => {
      const chip = e.target.closest('.ob-chip');
      if (!chip) return;
      ideaEl.value = chip.dataset.prompt || '';
      autoGrow(ideaEl);
      ideaEl.focus();
      if (errorEl) errorEl.hidden = true;
    });

    ideaEl.addEventListener('input', () => autoGrow(ideaEl));
    ctaBtn.addEventListener('click', () => runGeneration());
  }

  function populateChips() {
    const container = qs('ob-chips');
    if (!container) return;
    const role  = state.role || 'other';
    const chips = ROLE_CHIPS[role] || ROLE_CHIPS.other;
    container.innerHTML = chips.map(prompt =>
      `<button class="ob-chip" type="button" role="listitem" data-prompt="${escHtml(prompt)}">"${escHtml(prompt)}"</button>`
    ).join('');
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.max(88, el.scrollHeight) + 'px';
  }

  async function runGeneration() {
    const ideaEl   = qs('ob-idea');
    const ctaBtn   = qs('ob-s3-cta');
    const errorEl  = qs('ob-s3-error');
    const skeleton = qs('ob-preview-skeleton');
    const emptyEl  = qs('ob-preview-empty');

    const idea = (ideaEl?.value || '').trim();
    if (!idea) {
      errorEl.textContent = 'Add a thought before generating.';
      errorEl.hidden      = false;
      ideaEl?.focus();
      return;
    }
    errorEl.hidden   = true;
    ctaBtn.disabled  = true;
    ctaBtn.textContent = 'Generating...';
    if (skeleton) skeleton.hidden = false;
    if (emptyEl)  emptyEl.hidden  = true;

    try {
      const res = await fetch('/api/generate', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify({ path: 'idea', raw_idea: idea }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok || !data.post) {
        throw new Error(data.error || 'generation_failed');
      }

      state.postId         = data.id;
      state.post           = data.post;
      state.quality        = data.quality;
      state.archetypeUsed  = data.archetypeUsed;
      state.hookConfidence = data.hookConfidence;

      const passed = !!(data.quality?.passed || data.quality?.passed_gate);

      if (passed) {
        // Populate archetype reveal before showing 4a
        populateArchetypeReveal(data.archetypeUsed);
        showScreen('4a');
        fireConfetti();
        setTimeout(() => {
          showScreen('4b');
          renderPostAndScore(data);
        }, 2400);
      } else {
        // Force-returned post — skip celebration, show directly
        showScreen('4b');
        renderPostAndScore(data);
      }
    } catch (e) {
      console.error('[onboarding] generation error:', e);
      errorEl.textContent = 'Something went wrong. Please try again.';
      errorEl.hidden      = false;
      if (skeleton) skeleton.hidden = true;
      if (emptyEl)  emptyEl.hidden  = false;
    } finally {
      ctaBtn.disabled    = false;
      ctaBtn.textContent = 'Generate my first post →';
      if (skeleton) skeleton.hidden = true;
    }
  }

  /* ── Screen 4a: Archetype reveal ─────────────────────── */
  function populateArchetypeReveal(archetype) {
    if (!archetype) return;
    const key  = archetype.toUpperCase();
    const meta = ARCHETYPE_META[key];
    if (!meta) return;

    const wrap    = qs('ob-4a-archetype');
    const badge   = qs('ob-4a-archetype-badge');
    const descEl  = qs('ob-4a-archetype-desc');
    const example = qs('ob-4a-archetype-example');

    if (badge)   badge.textContent   = key;
    if (descEl)  descEl.textContent  = meta.desc;
    if (example) example.textContent = meta.example;
    if (wrap)    wrap.hidden         = false;
  }

  /* ── Screen 4b: Post + score ──────────────────────────── */
  function renderPostAndScore(data) {
    const quality   = data.quality;
    const archetype = data.archetypeUsed;
    const post      = data.post || state.post || '';

    const postOut = qs('ob-post-output');
    if (postOut) {
      postOut.value = post;
      autoGrow(postOut);
    }

    if (quality) {
      const scoreBar = qs('ob-score-bar');
      if (scoreBar) scoreBar.classList.add('visible');

      animateObScore(quality.score || 0);

      const scoreNum = qs('ob-score-number');
      if (scoreNum) {
        scoreNum.className = '';
        const s = quality.score || 0;
        if      (s >= 75) scoreNum.classList.add('pass');
        else if (s >= 50) scoreNum.classList.add('borderline');
        else              scoreNum.classList.add('fail');
      }

      if (archetype) {
        const key  = archetype.toUpperCase();
        const badge = qs('ob-archetype-badge');
        if (badge) { badge.textContent = key; badge.style.display = ''; }

        // Why-hook explanation
        const meta   = ARCHETYPE_META[key];
        const whyEl  = qs('ob-4b-hook-why');
        if (whyEl && meta) {
          whyEl.textContent = `We identified a ${key} hook in your idea — ${meta.desc.toLowerCase()}.`;
          whyEl.hidden = false;
        }
      }

      const passed = !!(quality.passed || quality.passed_gate);
      const pill   = qs('ob-passfail-pill');
      if (pill) {
        pill.textContent = passed ? '● Passed' : '● Needs work';
        pill.className   = 'passfail-pill ' + (passed ? 'pass' : 'fail');
      }

      const errors   = quality.errors   || [];
      const warnings = quality.warnings || [];
      const allItems = [...errors.map(t => ({ t, type: 'error' })), ...warnings.map(t => ({ t, type: 'warn' }))];
      const sugBtn   = qs('ob-suggestions-toggle');
      const sugList  = qs('ob-suggestions-list');

      if (allItems.length && sugBtn && sugList) {
        sugBtn.classList.add('visible');
        sugBtn.textContent = `▸ ${allItems.length} suggestions to review`;
        sugList.innerHTML  = allItems.map(item =>
          `<div class="suggestion-item" role="listitem">${item.type === 'error' ? '⚠ ' : '· '}${escHtml(item.t)}</div>`
        ).join('');

        sugBtn.addEventListener('click', () => {
          state.suggestionsOpen = !state.suggestionsOpen;
          sugList.classList.toggle('visible', state.suggestionsOpen);
          sugBtn.textContent = state.suggestionsOpen
            ? `▾ ${allItems.length} suggestions`
            : `▸ ${allItems.length} suggestions to review`;
          sugBtn.setAttribute('aria-expanded', String(state.suggestionsOpen));
        });
      }
    }
  }

  function fireConfetti() {
    if (typeof confetti !== 'function') return;
    const burst = (opts) => confetti({ startVelocity: 30, spread: 70, ticks: 80, zIndex: 999, ...opts });
    burst({ particleCount: 80, origin: { x: 0.5, y: 0.55 } });
    setTimeout(() => burst({ particleCount: 50, origin: { x: 0.25, y: 0.6 } }), 220);
    setTimeout(() => burst({ particleCount: 50, origin: { x: 0.75, y: 0.6 } }), 380);
  }

  function animateObScore(target) {
    const el = qs('ob-score-number');
    if (!el) return;
    const start    = performance.now();
    const duration = 600;
    function step(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased    = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(eased * target);
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ── Screen 4b: CTA buttons ──────────────────────────── */
  function initScreen4b() {
    qs('ob-s4b-continue')?.addEventListener('click', () => showScreen(5));
    qs('ob-s4b-skip')?.addEventListener('click', () => {
      markOnboardingComplete();
      window.location.href = state.postId
        ? `/preview.html?post_id=${encodeURIComponent(state.postId)}`
        : '/drafts.html';
    });
  }

  /* ── Screen 5: LinkedIn ───────────────────────────────── */
  function initScreen5() {
    qs('ob-s5-skip')?.addEventListener('click', () => showScreen(6));
  }

  function checkLinkedInReturn() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('linkedin') === 'connected') {
      markOnboardingComplete().finally(() => {
        window.location.href = '/dashboard.html';
      });
      return true;
    }
    return false;
  }

  /* ── Screen 6: Voice deepening ────────────────────────── */
  function initScreen6() {
    const ctaBtn  = qs('ob-s6-cta');
    const loadEl  = qs('ob-s6-loading');
    const skipBtn = qs('ob-s6-skip');
    const gotoBtn = qs('ob-goto-draft');

    const dest = () => state.postId
      ? `/preview.html?post_id=${encodeURIComponent(state.postId)}`
      : '/drafts.html';

    ctaBtn?.addEventListener('click', async () => {
      const pain       = (qs('ob-pain').value       || '').trim() || null;
      const contrarian = (qs('ob-contrarian').value || '').trim() || null;
      const samples    = (qs('ob-samples').value    || '').trim() || null;

      ctaBtn.disabled = true;
      loadEl.hidden   = false;

      try {
        await fetch('/api/profile', {
          method:  'POST',
          headers: apiHeaders(),
          body:    JSON.stringify({
            audience_pain:       pain,
            contrarian_view:     contrarian,
            writing_samples:     samples,
            onboarding_complete: 1,
          }),
        });
        // Give fingerprint extraction a moment to kick off
        await new Promise(r => setTimeout(r, 1800));
        window.location.href = dest();
      } catch (e) {
        console.error('[onboarding] screen 6 save error:', e);
        ctaBtn.disabled = false;
        loadEl.hidden   = true;
      }
    });

    skipBtn?.addEventListener('click', async () => {
      skipBtn.disabled = true;
      await markOnboardingComplete();
      window.location.href = dest();
    });

    gotoBtn?.addEventListener('click', () => { window.location.href = dest(); });
  }

  /* ── Mark onboarding complete (shared helper) ─────────── */
  async function markOnboardingComplete() {
    try {
      await fetch('/api/profile', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify({ onboarding_complete: 1 }),
      });
    } catch (e) {
      console.error('[onboarding] markOnboardingComplete error:', e);
    }
  }

  /* ── Boot ─────────────────────────────────────────────── */
  async function init() {
    if (window.scouthookAuthReady) {
      await window.scouthookAuthReady;
    }

    let currentUser = null;
    try {
      const meRes  = await fetch('/api/auth/me');
      const meData = await meRes.json();
      if (!meData.ok || !meData.user) {
        window.location.href = '/login.html';
        return;
      }
      currentUser = meData.user;
    } catch {
      window.location.href = '/login.html';
      return;
    }

    try {
      const profRes  = await fetch(`/api/profile/${encodeURIComponent(currentUser.user_id)}`,
        { headers: apiHeaders() });
      const profData = await profRes.json();
      if (profData.profile?.onboarding_complete) {
        window.location.href = '/dashboard.html';
        return;
      }
    } catch {
      // Non-fatal — continue with the wizard
    }

    if (checkLinkedInReturn()) return;

    initScreen1();
    initScreen3();
    initScreen4b();
    initScreen5();
    initScreen6();

    showScreen(1);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Onboarding.init);

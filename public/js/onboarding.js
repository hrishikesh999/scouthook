'use strict';

/* ============================================================
   onboarding.js — Scouthook first-time wizard
   Controls the 7-screen setup flow: role → voice basics →
   generate first post → celebration → post + score →
   LinkedIn connect (optional) → voice deepening (optional).
   ============================================================ */

const Onboarding = (() => {

  /* ── Module state ─────────────────────────────────────── */
  const state = {
    role:            null,  // e.g. "consultant"
    roleCustom:      null,  // free-text for role === "other"
    postId:          null,
    post:            null,
    quality:         null,
    archetypeUsed:   null,
    hookConfidence:  null,
    currentScreen:   '1',
    suggestionsOpen: false,
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
    // id may be a number or string: 1, 2, 3, '4a', '4b', 5, 6, 'confirm'
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
    const dots    = qs('ob-step-dots');
    if (!dots) return;
    const dotMap  = { '2': '2', '3': '3', '4b': '4b' };
    const showFor = Object.keys(dotMap);
    dots.hidden = !showFor.includes(screenKey);
    if (!dots.hidden) {
      qsa('.ob-dot').forEach(dot => {
        dot.classList.toggle('active', dot.dataset.step === dotMap[screenKey]);
      });
    }
  }

  /* ── Screen 1: Role cards ─────────────────────────────── */
  function initScreen1() {
    const cards      = qsa('.ob-role-card');
    const customWrap = qs('ob-role-custom-wrap');
    const errorEl    = qs('ob-s1-error');

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
        if (errorEl) errorEl.hidden = true;
      });
    });

    qs('ob-s1-cta').addEventListener('click', () => {
      if (!state.role) {
        errorEl.hidden = false;
        return;
      }
      if (state.role === 'other') {
        const custom = (qs('ob-role-custom').value || '').trim();
        if (!custom) {
          errorEl.textContent = 'Please describe what you do to continue.';
          errorEl.hidden = false;
          return;
        }
        state.roleCustom = custom;
      }
      errorEl.hidden = true;
      showScreen(2);
    });
  }

  /* ── Screen 2: Voice basics ───────────────────────────── */
  function initScreen2() {
    const ctaBtn   = qs('ob-s2-cta');
    const loadEl   = qs('ob-s2-loading');
    const errorEl  = qs('ob-s2-error');

    // Allow submitting with Enter key on either field
    ['ob-niche', 'ob-audience'].forEach(id => {
      const el = qs(id);
      if (el) el.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); ctaBtn.click(); }
      });
    });

    ctaBtn.addEventListener('click', async () => {
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
        const res = await fetch('/api/profile', {
          method:  'POST',
          headers: apiHeaders(),
          body:    JSON.stringify({
            content_niche: niche,
            audience_role: audience,
            user_role:     roleValue,
          }),
        });
        if (!res.ok) throw new Error('profile_save_failed');
        // Hold the "Building your voice profile..." state for a beat so it
        // doesn't feel like the save was instant — gives users confidence that
        // something real just happened.
        await new Promise(r => setTimeout(r, 2000));
        showScreen(3);
      } catch (e) {
        console.error('[onboarding] screen 2 save error:', e);
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

    // Prompt chips populate and focus the textarea
    qsa('.ob-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        ideaEl.value = chip.dataset.prompt || '';
        autoGrow(ideaEl);
        ideaEl.focus();
        if (errorEl) errorEl.hidden = true;
      });
    });

    // Auto-grow textarea
    ideaEl.addEventListener('input', () => autoGrow(ideaEl));

    ctaBtn.addEventListener('click', () => runGeneration());
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

      // Stash results in module state
      state.postId         = data.id;
      state.post           = data.post;
      state.quality        = data.quality;
      state.archetypeUsed  = data.archetypeUsed;
      state.hookConfidence = data.hookConfidence;

      const passed = !!(data.quality?.passed || data.quality?.passed_gate);

      if (passed) {
        // Quality gate passed — celebrate, then let the user READ their post
        // on screen 4b before asking them to deepen their voice profile.
        showScreen('4a');
        fireConfetti();
        setTimeout(() => {
          showScreen('4b');
          renderPostAndScore(data);
        }, 2400);
      } else {
        // Force-returned post — skip celebration, show the post directly.
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

  /* ── Screen 4b: Post + score ──────────────────────────── */
  function renderPostAndScore(data) {
    const quality   = data.quality;
    const archetype = data.archetypeUsed;
    const post      = data.post || state.post || '';

    // Populate post textarea
    const postOut = qs('ob-post-output');
    if (postOut) {
      postOut.value = post;
      autoGrow(postOut);
    }

    // Score bar
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
        const badge = qs('ob-archetype-badge');
        if (badge) { badge.textContent = archetype.toUpperCase(); badge.style.display = ''; }
      }

      const passed = !!(quality.passed || quality.passed_gate);
      const pill   = qs('ob-passfail-pill');
      if (pill) {
        pill.textContent = passed ? '● Passed' : '● Needs work';
        pill.className   = 'passfail-pill ' + (passed ? 'pass' : 'fail');
      }

      // Suggestions
      const errors   = quality.errors   || [];
      const warnings = quality.warnings || [];
      const allItems = [...errors.map(t => ({ t, type: 'error' })), ...warnings.map(t => ({ t, type: 'warn' }))];
      const sugBtn   = qs('ob-suggestions-toggle');
      const sugList  = qs('ob-suggestions-list');

      if (allItems.length && sugBtn && sugList) {
        sugBtn.classList.add('visible');
        sugBtn.textContent   = `▸ ${allItems.length} suggestions to review`;
        sugList.innerHTML    = allItems.map(item =>
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

    // Wire CTAs once (use { once: true } to prevent duplicate listeners on re-renders)
    // Golden: continue to voice deepening (Screen 6)
    qs('ob-s4b-continue')?.addEventListener('click', () => showScreen(6), { once: true });
    // Primary: go straight to the editor — mark complete in background so navigation is instant
    qs('ob-s4b-skip')?.addEventListener('click', () => {
      markOnboardingComplete(); // fire-and-forget
      window.location.href = state.postId
        ? `/generate.html?postId=${encodeURIComponent(state.postId)}`
        : '/drafts.html';
    }, { once: true });
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

  /* ── Screen 5: LinkedIn ───────────────────────────────── */
  function initScreen5() {
    qs('ob-s5-skip')?.addEventListener('click', () => showScreen(6));
  }

  function checkLinkedInReturn() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('linkedin') === 'connected') {
      // Came back from LinkedIn OAuth during onboarding — mark complete, go to dashboard
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
      ? `/generate.html?postId=${encodeURIComponent(state.postId)}`
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
        // Give fingerprint extraction a moment to kick off, then open the editor.
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

    // gotoBtn lives on the (now unused) confirm screen — keep it wired as a
    // safety net in case a user somehow reaches it.
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
    // Wait for session.js to synchronise the auth state
    if (window.scouthookAuthReady) {
      await window.scouthookAuthReady;
    }

    // Verify the user is authenticated (server already enforced this via
    // requireLoginHtml, but a client-side check gives a clean redirect)
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

    // If the user already completed onboarding, redirect to dashboard
    try {
      const profRes  = await fetch(`/api/profile/${encodeURIComponent(currentUser.user_id)}`,
        { headers: apiHeaders() });
      const profData = await profRes.json();
      if (profData.profile?.onboarding_complete) {
        window.location.href = '/dashboard.html';
        return;
      }
    } catch {
      // Non-fatal — continue with the wizard even if profile check fails
    }

    // Handle returning from LinkedIn OAuth mid-onboarding
    if (checkLinkedInReturn()) return;

    // Initialise all screens (event listeners are cheap to attach up-front)
    initScreen1();
    initScreen2();
    initScreen3();
    initScreen5();
    initScreen6();

    // Show the first screen
    showScreen(1);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Onboarding.init);

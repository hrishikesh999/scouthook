'use strict';

/* ============================================================
   onboarding.js — Scouthook first-time wizard (v2)
   9-step flow:
     s1. Role selection
     s2. Connect LinkedIn
     s3. Website URL (extract → pre-seed brand fields)
     s4. What do you do?
     s5. What industry?
     s6. Brand personality (→ runs brand voice stage-2 extraction)
     s7. Target audience description
     s8. Demographics / customer type (→ runs audience stage-2 extraction)
     s9. Celebration + CTA to generate.html
   ============================================================ */

const Onboarding = (() => {

  /* ── State ─────────────────────────────────────────────── */
  const state = {
    role:                  null,
    linkedinConnected:     false,
    websiteUrl:            null,
    brandDescription:      '',
    audienceExtracted:     '',    // audience_description from website extraction
    brandIndustry:         '',
    brandPersonalityTraits: [],   // string[]
    audiencePrimary:       '',
    audienceDetail:        '',
  };

  /* ── Utilities ───────────────────────────────────────────── */
  const qs  = id  => document.getElementById(id);
  const qsa = sel => document.querySelectorAll(sel);

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── Screen navigation ──────────────────────────────────── */
  const STEPS = ['s1','s2','s3','s4','s5','s6','s7','s8','s9'];

  function showScreen(id) {
    qsa('.ob-screen').forEach(s => s.classList.remove('active'));
    const target = qs(`ob-${id}`);
    if (target) {
      target.classList.add('active');
      window.scrollTo(0, 0);
    }
    updateDots(id);
  }

  function updateDots(id) {
    const dotsEl = qs('ob-step-dots');
    if (!dotsEl) return;
    const stepNum = String(STEPS.indexOf(id) + 1);
    dotsEl.hidden = false;
    qsa('.ob-dot').forEach(dot => {
      dot.classList.toggle('active', dot.dataset.step === stepNum);
    });
  }

  /* ── Step 1: Role ───────────────────────────────────────── */
  function initS1() {
    qsa('.ob-role-card').forEach(card => {
      card.addEventListener('click', () => {
        qsa('.ob-role-card').forEach(c => {
          c.classList.remove('selected');
          c.setAttribute('aria-pressed', 'false');
        });
        card.classList.add('selected');
        card.setAttribute('aria-pressed', 'true');
        state.role = card.dataset.role;
        // Save role immediately
        fetch('/api/profile', {
          method:  'POST',
          headers: apiHeaders(),
          body:    JSON.stringify({ user_role: state.role }),
        }).catch(() => {});
        setTimeout(() => {
          showScreen('s2');
          initLinkedInScreen();
        }, 200);
      });
    });
  }

  /* ── Step 2: Connect LinkedIn ──────────────────────────── */
  async function initLinkedInScreen() {
    const connectedEl    = qs('ob-li-connected');
    const disconnectedEl = qs('ob-li-disconnected');
    const nextBtn        = qs('ob-s2-next');

    try {
      const res  = await fetch('/api/linkedin/status', { headers: apiHeaders() });
      const data = await res.json();

      if (data.connected) {
        state.linkedinConnected = true;
        // Show connected card
        const photoEl = qs('ob-li-photo');
        const nameEl  = qs('ob-li-name');
        if (photoEl && data.photo_url) {
          photoEl.src = data.photo_url;
          photoEl.alt = data.name || 'LinkedIn profile photo';
        }
        if (nameEl && data.name) nameEl.textContent = data.name;
        connectedEl.hidden    = false;
        disconnectedEl.hidden = true;
        nextBtn.hidden        = false;
      } else {
        // Wire up the connect button with correct auth params
        const connectBtn = qs('ob-li-connect-btn');
        if (connectBtn) {
          const uid = getUserId();
          const tid = localStorage.getItem('scouthook_tid') || '';
          connectBtn.href = `/api/linkedin/connect?from=onboarding&_uid=${encodeURIComponent(uid)}&_tid=${encodeURIComponent(tid)}`;
        }
        connectedEl.hidden    = true;
        disconnectedEl.hidden = false;
        nextBtn.hidden        = true;
      }
    } catch {
      // Non-fatal — show disconnected state
      connectedEl.hidden    = true;
      disconnectedEl.hidden = false;
      nextBtn.hidden        = true;
    }
  }

  function initS2() {
    qs('ob-s2-back')?.addEventListener('click', () => showScreen('s1'));
    qs('ob-s2-next')?.addEventListener('click', () => showScreen('s3'));
    qs('ob-s2-skip')?.addEventListener('click', () => showScreen('s3'));
  }

  /* ── Step 3: Website URL ────────────────────────────────── */
  function initS3() {
    qs('ob-s3-back')?.addEventListener('click', () => showScreen('s2'));
    qs('ob-website-next')?.addEventListener('click', submitWebsite);
    qs('ob-website-skip')?.addEventListener('click', () => showScreen('s4'));
    qs('ob-website-url')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') submitWebsite();
    });
  }

  async function submitWebsite() {
    const input  = qs('ob-website-url');
    const errEl  = qs('ob-website-error');
    const raw    = (input?.value || '').trim();

    if (!raw) { showScreen('s4'); return; }

    const url   = `https://${raw}`;
    const valid = /^https:\/\/.+\..+/.test(url);
    if (errEl) errEl.hidden = valid;
    if (!valid) { input?.focus(); return; }

    state.websiteUrl = url;

    // Show extraction spinner, disable button
    const nextBtn     = qs('ob-website-next');
    const extractingEl = qs('ob-website-extracting');
    if (nextBtn) nextBtn.disabled = true;
    if (extractingEl) extractingEl.hidden = false;

    // Save URL
    fetch('/api/profile', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify({ website_url: url }),
    }).catch(() => {});

    try {
      const res  = await fetch('/api/profile/extract-website', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify({ url }),
      });
      const data = await res.json();

      if (data.ok) {
        const fields = {};
        ['brand_description', 'elevator_main_result', 'audience_description', 'brand_core_beliefs']
          .forEach(k => { if (data[k]) fields[k] = data[k]; });

        // Pre-seed state fields from extraction for later pre-fill
        if (data.brand_description)   state.brandDescription   = data.brand_description;
        if (data.audience_description) state.audienceExtracted = data.audience_description;

        if (Object.keys(fields).length > 0) {
          await fetch('/api/profile', {
            method:  'POST',
            headers: apiHeaders(),
            body:    JSON.stringify(fields),
          });
        }
      }
    } catch {
      // Non-fatal — continue without extraction data
    }

    if (extractingEl) extractingEl.hidden = true;
    if (nextBtn) nextBtn.disabled = false;

    // Pre-fill step 4 textarea if we got brand_description
    const descEl  = qs('ob-brand-description');
    const descHint = qs('ob-brand-prefill-hint');
    if (descEl && state.brandDescription) {
      descEl.value = state.brandDescription;
      if (descHint) descHint.hidden = false;
    }

    showScreen('s4');
  }

  /* ── Step 4: What do you do? ────────────────────────────── */
  function initS4() {
    qs('ob-s4-back')?.addEventListener('click', () => showScreen('s3'));
    qs('ob-s4-next')?.addEventListener('click', () => {
      const val = (qs('ob-brand-description')?.value || '').trim();
      if (!val) { qs('ob-brand-description')?.focus(); return; }
      state.brandDescription = val;
      showScreen('s5');
    });
    qs('ob-brand-description')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) qs('ob-s4-next')?.click();
    });
  }

  /* ── Step 5: Industry ───────────────────────────────────── */
  function initS5() {
    qs('ob-s5-back')?.addEventListener('click', () => showScreen('s4'));
    qs('ob-s5-next')?.addEventListener('click', () => {
      const val = qs('ob-brand-industry')?.value || '';
      state.brandIndustry = val;
      showScreen('s6');
    });
  }

  /* ── Step 6: Brand personality ──────────────────────────── */
  function initS6() {
    qs('ob-s6-back')?.addEventListener('click', () => showScreen('s5'));

    qsa('.ob-trait-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const trait    = chip.dataset.trait;
        const selected = state.brandPersonalityTraits;
        const isOn     = chip.classList.contains('selected');

        if (isOn) {
          chip.classList.remove('selected');
          chip.setAttribute('aria-pressed', 'false');
          state.brandPersonalityTraits = selected.filter(t => t !== trait);
        } else {
          if (selected.length >= 5) return; // max 5
          chip.classList.add('selected');
          chip.setAttribute('aria-pressed', 'true');
          state.brandPersonalityTraits = [...selected, trait];
        }

        const countEl = qs('ob-trait-count');
        if (countEl) countEl.textContent = `${state.brandPersonalityTraits.length} / 5 selected`;
      });
    });

    qs('ob-s6-next')?.addEventListener('click', runBrandVoiceExtraction);
  }

  async function runBrandVoiceExtraction() {
    const generatingEl = qs('ob-bv-generating');
    const nextBtn      = qs('ob-s6-next');
    if (nextBtn) nextBtn.disabled = true;
    if (generatingEl) generatingEl.hidden = false;

    // 1. Save brand voice stage-1 fields
    try {
      await fetch('/api/profile', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify({
          brand_description:       state.brandDescription,
          brand_industry:          state.brandIndustry || undefined,
          brand_personality_traits: JSON.stringify(state.brandPersonalityTraits),
        }),
      });
    } catch { /* non-fatal */ }

    // 2. Run stage-2 prefill generation
    let aiFields = {};
    try {
      const res  = await fetch('/api/profile/brand-voice/generate', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify({ mode: 'prefill' }),
      });
      const data = await res.json();
      if (data.ok) {
        const pick = [
          'elevator_main_result','elevator_mechanism','brand_archetype',
          'brand_core_beliefs','brand_phrases_to_use','brand_story_origin',
          'brand_voice_profile_json',
        ];
        pick.forEach(k => { if (data[k] !== undefined) aiFields[k] = data[k]; });
      }
    } catch { /* non-fatal */ }

    // 3. Save AI-returned fields
    if (Object.keys(aiFields).length > 0) {
      fetch('/api/profile', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify(aiFields),
      }).catch(() => {});
    }

    if (generatingEl) generatingEl.hidden = true;
    if (nextBtn) nextBtn.disabled = false;
    showScreen('s7');
  }

  /* ── Step 7: Target audience ────────────────────────────── */
  function initS7() {
    qs('ob-s7-back')?.addEventListener('click', () => showScreen('s6'));
    qs('ob-s7-next')?.addEventListener('click', () => {
      const val = (qs('ob-audience-primary')?.value || '').trim();
      if (!val) { qs('ob-audience-primary')?.focus(); return; }
      state.audiencePrimary = val;
      showScreen('s8');
    });
    qs('ob-audience-primary')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) qs('ob-s7-next')?.click();
    });

    // Pre-fill from website extraction if available
    // Done lazily here (not at extraction time) so the textarea exists in the DOM.
    if (state.audienceExtracted) {
      const ta  = qs('ob-audience-primary');
      const hint = qs('ob-audience-prefill-hint');
      if (ta && !ta.value) {
        ta.value = state.audienceExtracted;
        if (hint) hint.hidden = false;
      }
    }
  }

  /* ── Step 8: Demographics ───────────────────────────────── */
  function initS8() {
    qs('ob-s8-back')?.addEventListener('click', () => showScreen('s7'));
    qs('ob-s8-next')?.addEventListener('click', runAudienceExtraction);
    qs('ob-audience-detail')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runAudienceExtraction();
    });
  }

  async function runAudienceExtraction() {
    const generatingEl = qs('ob-aud-generating');
    const nextBtn      = qs('ob-s8-next');
    if (nextBtn) nextBtn.disabled = true;
    if (generatingEl) generatingEl.hidden = false;

    const detail = (qs('ob-audience-detail')?.value || '').trim();
    state.audienceDetail = detail;

    // Combine primary + detail into a single audience_description
    const parts = [state.audiencePrimary, detail].filter(Boolean);
    const audienceDescription = parts.join('. ');

    // 1. Save audience_description
    try {
      await fetch('/api/profile', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify({ audience_description: audienceDescription }),
      });
    } catch { /* non-fatal */ }

    // 2. Run stage-2 audience prefill generation
    let aiFields = {};
    try {
      const res  = await fetch('/api/profile/audience/generate', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify({ mode: 'prefill' }),
      });
      const data = await res.json();
      if (data.ok) {
        const pick = [
          'audience_goals','audience_obstacles','audience_core_beliefs_market',
          'audience_buying_stage','audience_market_sophistication','audience_profile_json',
        ];
        pick.forEach(k => { if (data[k] !== undefined) aiFields[k] = data[k]; });
      }
    } catch { /* non-fatal */ }

    // 3. Save AI-returned audience fields
    if (Object.keys(aiFields).length > 0) {
      fetch('/api/profile', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify(aiFields),
      }).catch(() => {});
    }

    // 4. Mark onboarding complete
    markOnboardingComplete().catch(() => {});

    if (generatingEl) generatingEl.hidden = true;
    if (nextBtn) nextBtn.disabled = false;

    showScreen('s9');
    fireConfetti();
  }

  /* ── Step 9: Celebration ────────────────────────────────── */
  function initS9() {
    qs('ob-write-first-post')?.addEventListener('click', () => {
      window.location.href = '/generate.html';
    });
  }

  /* ── Confetti ───────────────────────────────────────────── */
  function fireConfetti() {
    // canvas-confetti sets window.confetti; wait one rAF so the s9 screen has
    // painted before the canvas fires (avoids the burst rendering behind a
    // display:none screen that hasn't transitioned yet).
    const fn = window.confetti;
    if (typeof fn !== 'function') return;
    requestAnimationFrame(() => {
      fn({ particleCount: 400, startVelocity: 55, spread: 100, origin: { x: 0.5, y: 0.6 }, ticks: 180, zIndex: 9999 });
      setTimeout(() => {
        fn({ particleCount: 250, startVelocity: 65, spread: 60, angle: 60,  origin: { x: 0,   y: 0.65 }, ticks: 160, zIndex: 9999 });
        fn({ particleCount: 250, startVelocity: 65, spread: 60, angle: 120, origin: { x: 1,   y: 0.65 }, ticks: 160, zIndex: 9999 });
      }, 150);
      setTimeout(() => {
        fn({ particleCount: 200, startVelocity: 40, spread: 120, origin: { x: 0.3, y: 0.5 }, ticks: 140, zIndex: 9999 });
        fn({ particleCount: 200, startVelocity: 40, spread: 120, origin: { x: 0.7, y: 0.5 }, ticks: 140, zIndex: 9999 });
      }, 400);
      setTimeout(() => {
        fn({ particleCount: 150, startVelocity: 20, spread: 140, origin: { x: 0.5, y: 0.4 }, gravity: 0.5, ticks: 200, zIndex: 9999 });
      }, 700);
    });
  }

  /* ── LinkedIn OAuth return ──────────────────────────────── */
  // Called after initS*() so all screens are wired. Shows step 2 with the
  // connected card — user sees confirmation then clicks Next to continue.
  function checkLinkedInReturn() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('linkedin') !== 'connected') return false;
    showScreen('s2');
    initLinkedInScreen(); // re-fetches status and renders connected card
    return true;
  }

  /* ── Shared helpers ─────────────────────────────────────── */
  async function markOnboardingComplete() {
    await fetch('/api/profile', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify({
        onboarding_complete:     1,
        onboarding_completed_at: new Date().toISOString(),
      }),
    });
  }

  /* ── Init ───────────────────────────────────────────────── */
  async function init() {
    if (window.scouthookAuthReady) {
      await window.scouthookAuthReady;
    }

    // Auth check
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

    // Already completed onboarding → go to dashboard
    try {
      const uid = currentUser.user_id;
      if (uid) {
        const profRes  = await fetch(`/api/profile/${encodeURIComponent(uid)}`, { headers: apiHeaders() });
        const profData = await profRes.json();
        if (profData.profile?.onboarding_complete) {
          window.location.href = '/dashboard.html';
          return;
        }
      }
    } catch { /* non-fatal */ }

    // Wire up all steps
    initS1();
    initS2();
    initS3();
    initS4();
    initS5();
    initS6();
    initS7();
    initS8();
    initS9();

    // Handle LinkedIn OAuth callback (returns ?linkedin=connected).
    // Must run after initS*() so screens and buttons are wired.
    if (checkLinkedInReturn()) return;

    showScreen('s1');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Onboarding.init);

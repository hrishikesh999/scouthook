'use strict';

/* ============================================================
   onboarding.js — Scouthook first-time wizard
   4-step PLG flow:
     s1. Role (5 cards, auto-advance)
     s4. Interview (website → questions)
     s5. Live progress (role-injected copy)
     s6. Post revealed (badges + hook chips + 2 CTAs)

   Removed from previous version:
     s2. Goal — deleted (state.funnelType removed)
     s7. Plan selection — deleted (Paddle references removed)
   ============================================================ */

const Onboarding = (() => {

  /* ── State ─────────────────────────────────────────────── */
  const state = {
    role:          null,   // e.g. 'consultant', 'coach', 'freelancer', 'founder', 'other'
    questionIndex: 0,
    answers:       [],     // [{ question, answer, field }] — field maps to DB column
    postId:        null,
    post:          null,
    vaultDocId:    null,   // set if user uploads a doc in the vault step
    writingSample: '',     // pasted writing sample from s2
    hotTake:       '',     // optional contrarian view captured after last Q&A question
  };

  /* ── Interview questions ─────────────────────────────────
     Two questions. context is the badge shown above each.
     field maps to the DB column the answer is saved to.
  ──────────────────────────────────────────────────────── */
  const QUESTIONS = [
    {
      context:     'Your voice — This is how we make posts sound like you, not a template.',
      text:        'If a close friend asked what you actually do all day, what would you tell them?',
      hint:        'Be as casual as you\'d actually be. Don\'t pitch — just describe.',
      placeholder: 'e.g. Honestly? I spend most of my time helping founders figure out why their pipeline is broken. Usually it\'s not what they think it is.',
      field:       'onboarding_q2',
    },
    {
      context:     'Your proof — Specific results make posts credible. Numbers beat adjectives every time.',
      text:        'Describe a specific result your work produced. Numbers if you have them.',
      hint:        'A client win, a project outcome, a measurable change you caused.',
      placeholder: 'e.g. Helped a B2B SaaS founder go from zero inbound to 4 qualified calls a month in 6 weeks — no paid ads.',
      field:       'onboarding_q3',
    },
  ];

  /* ── Archetype labels for hook badge ─────────────────── */
  const ARCHETYPE_LABELS = {
    CONFESSION:    'Confession',
    BEFORE_AFTER:  'Before/After',
    INSIGHT:       'Insight',
    DIRECT_ADDRESS:'Direct address',
    NUMBER:        'Number hook',
    MYTH_BUST:     'Myth bust',
    CURIOSITY_GAP: 'Curiosity gap',
    REFRAME:       'Reframe',
  };

  /* ── Role label map for processing screen ────────────── */
  const ROLE_LABELS = {
    consultant: 'consultant',
    coach:      'coach',
    fractional: 'fractional executive',
    freelancer: 'freelancer',
    founder:    'founder',
    other:      'your',
  };

  /* ── Utilities ───────────────────────────────────────── */
  const qs  = id  => document.getElementById(id);
  const qsa = sel => document.querySelectorAll(sel);

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  function safeParseJSON(val, fallback) {
    if (!val) return fallback;
    try { return JSON.parse(val); } catch { return fallback; }
  }

  /* ── Screen navigation ──────────────────────────────── */
  // Maps screen id → progress dot number
  // s1=role, s4=interview, s2=writing sample, s3=vault, s5=generating, s6=reveal
  const DOT_MAP = { s1: '1', s4: '2', s2: '3', s5: '4', s6: '5' };

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
    const activeDot = DOT_MAP[id];
    dotsEl.hidden = !activeDot;
    if (!dotsEl.hidden) {
      qsa('.ob-dot').forEach(dot => {
        dot.classList.toggle('active', dot.dataset.step === activeDot);
      });
    }
  }

  /* ── Screen 1: Role ─────────────────────────────────── */
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
        setTimeout(() => {
          showScreen('s4');
          showWebsiteStep();
        }, 200);
      });
    });
  }

  /* ── Screen 4: Interview ────────────────────────────── */
  function showWebsiteStep() {
    qs('ob-website-step').hidden    = false;
    qs('ob-profile-step').hidden    = true;
    qs('ob-question-step').hidden   = true;
    const backBtn = qs('ob-s4-back');
    if (backBtn) backBtn.onclick = () => showScreen('s1');
    qs('ob-website-url')?.focus();
  }

  function showProfileStep() {
    qs('ob-website-step').hidden    = true;
    qs('ob-profile-step').hidden    = false;
    qs('ob-question-step').hidden   = true;
    const backBtn = qs('ob-s4-back');
    if (backBtn) backBtn.onclick = () => showWebsiteStep();
    qs('ob-profile-answer')?.focus();
  }

  function submitProfileQuestion() {
    const val = (qs('ob-profile-answer')?.value || '').trim();
    if (val) {
      // Save to all three audience fields — the user's one sentence ("I help
      // early-stage founders close enterprise deals") contains niche, role, and
      // pain implicitly. Saving to all three ensures buildVoiceWritingSystemPrompt()
      // has non-null values for every audience block. Voice extraction will refine
      // these into distinct fields once Q&A answers are saved.
      fetch('/api/profile', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify({
          content_niche: val,
          audience_role: val,
          audience_pain: val,
        }),
      }).catch(() => {});
    }
    state.questionIndex = 0;
    renderQuestion();
  }

  function showQuestionStep() {
    qs('ob-website-step').hidden    = true;
    qs('ob-profile-step').hidden    = true;
    qs('ob-question-step').hidden   = false;
  }

  function renderQuestion() {
    showQuestionStep();
    const q     = QUESTIONS[state.questionIndex];
    const total = QUESTIONS.length;
    const idx   = state.questionIndex;
    const isLast = idx === total - 1;

    qs('ob-q-progress').textContent = `Question ${idx + 1} of ${total}`;
    qs('ob-q-context').textContent  = q.context;
    qs('ob-q-text').textContent     = q.text;
    const hintEl = qs('ob-q-hint');
    if (hintEl) hintEl.textContent  = q.hint || '';

    // Show expectation-setting preamble only on first question
    const preamble = qs('ob-question-preamble');
    if (preamble) preamble.hidden = idx !== 0;

    // Show optional hot take field only on last question
    const hotTakeWrap = qs('ob-hot-take-wrap');
    if (hotTakeWrap) {
      hotTakeWrap.hidden = !isLast;
      if (isLast) {
        const hotTakeInput = qs('ob-hot-take');
        if (hotTakeInput) hotTakeInput.value = state.hotTake || '';
      }
    }

    const answerEl = qs('ob-answer');
    answerEl.value       = state.answers[idx]?.answer || '';
    answerEl.placeholder = q.placeholder;
    answerEl.focus();

    const backBtn = qs('ob-s4-back');
    if (backBtn) {
      backBtn.onclick = () => {
        if (idx === 0) {
          showWebsiteStep();
        } else {
          state.questionIndex--;
          renderQuestion();
        }
      };
    }

    qs('ob-answer-next').textContent = isLast ? 'Generate my post →' : 'Next →';
  }

  function initS4() {
    // Website pre-step
    qs('ob-website-next')?.addEventListener('click', submitWebsite);
    qs('ob-website-skip')?.addEventListener('click', showProfileStep);
    qs('ob-website-url')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') submitWebsite();
    });

    // No-website profile question
    qs('ob-profile-next')?.addEventListener('click', submitProfileQuestion);
    qs('ob-profile-skip')?.addEventListener('click', () => {
      state.questionIndex = 0;
      renderQuestion();
    });
    qs('ob-profile-answer')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitProfileQuestion();
    });

    // Interview questions
    qs('ob-answer-next')?.addEventListener('click', advanceInterview);
    qs('ob-answer-skip')?.addEventListener('click', () => {
      recordAnswer('');
      advanceInterview(null, true);
    });
    qs('ob-answer')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) advanceInterview();
    });
  }

  function submitWebsite() {
    const input   = qs('ob-website-url');
    const errEl   = qs('ob-website-error');
    const raw     = (input?.value || '').trim();

    // Empty domain — treat same as skip
    if (!raw) {
      showProfileStep();
      return;
    }

    // Prepend protocol; the user only types the domain
    const url   = `https://${raw}`;
    const valid = /^https:\/\/.+\..+/.test(url);
    errEl.hidden = valid;
    if (!valid) { input?.focus(); return; }

    // Save website_url immediately — don't wait for extraction.
    fetch('/api/profile', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify({ website_url: url }),
    }).catch(() => {});

    // Fire website extraction in the background while user answers Q&A.
    // By the time they finish typing (~2–3 minutes), extraction will have
    // completed and the fields will be saved before saveProfileAndGenerate() fires.
    extractWebsiteInBackground(url);

    // Advance to interview immediately — no spinner wait.
    state.questionIndex = 0;
    renderQuestion();
  }

  function extractWebsiteInBackground(url) {
    fetch('/api/profile/extract-website', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify({ url }),
    })
    .then(r => r.json())
    .then(data => {
      if (!data.ok) return;
      const fields = {};
      ['content_niche', 'audience_role', 'audience_pain', 'contrarian_view', 'business_positioning']
        .forEach(k => { if (data[k]) fields[k] = data[k]; });
      if (Object.keys(fields).length === 0) return;
      fetch('/api/profile', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify(fields),
      }).catch(() => {});
    })
    .catch(() => {}); // Non-fatal
  }

  function recordAnswer(override) {
    const q   = QUESTIONS[state.questionIndex];
    const val = override !== undefined ? override : (qs('ob-answer').value || '').trim();
    state.answers[state.questionIndex] = {
      question: q.text,
      answer:   val,
      field:    q.field,
    };
  }

  function advanceInterview(e, skipping = false) {
    if (!skipping) recordAnswer();
    if (state.questionIndex < QUESTIONS.length - 1) {
      state.questionIndex++;
      renderQuestion();
    } else {
      // Capture optional hot take before leaving the interview screen
      state.hotTake = (qs('ob-hot-take')?.value || '').trim();
      showScreen('s2');
      initS2Focus();
    }
  }

  /* ── Screen 2: Writing sample paste ─────────────────── */
  function initS2Focus() {
    qs('ob-writing-sample')?.focus();
  }

  function initS2() {
    const textarea   = qs('ob-writing-sample');
    const charCount  = qs('ob-writing-char-count');
    const nextBtn    = qs('ob-writing-next');
    const skipBtn    = qs('ob-writing-skip');
    const backBtn    = qs('ob-s2-back');

    const skipCost = qs('ob-writing-skip-cost');

    if (textarea && charCount) {
      textarea.addEventListener('input', () => {
        const len = textarea.value.length;
        charCount.textContent = len > 0 ? `${len} / 1200 characters` : '';
        // Hide the skip-cost warning once the user has typed something
        if (skipCost) skipCost.hidden = len > 0;
      });
    }

    if (backBtn) {
      backBtn.addEventListener('click', () => {
        // Back goes to last question — must re-activate S4 screen first
        state.questionIndex = QUESTIONS.length - 1;
        showScreen('s4');
        renderQuestion();
      });
    }

    function advanceFromWriting() {
      const sample = (textarea?.value || '').trim();
      state.writingSample = sample;
      // Writing sample is now merged into the Q&A payload in saveProfileAndGenerate()
      // so both arrive in a single DB write — eliminating the race condition where
      // extractVoiceDNAFromQA would run before writing_samples was committed.
      saveProfileAndGenerate();
    }

    nextBtn?.addEventListener('click', advanceFromWriting);
    skipBtn?.addEventListener('click', () => {
      state.writingSample = '';
      saveProfileAndGenerate();
    });
    textarea?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) advanceFromWriting();
    });
  }

  /* ── Screen 5: Live progress + generation ───────────── */
  const PROGRESS_STEPS = [
    { id: 'ob-step-1', ms: 900  },
    { id: 'ob-step-2', ms: 1600 },
    { id: 'ob-step-3', ms: 1200 },
    { id: 'ob-step-4', ms: 900  },
    { id: 'ob-step-5', ms: 700  },
  ];

  function injectProcessingCopy() {
    const roleLabel = ROLE_LABELS[state.role] || 'your';
    const step2Label = qs('ob-step-2-label');
    if (step2Label) step2Label.textContent = `Applying your ${roleLabel} context`;
  }

  function animateProgress(generationPromise) {
    PROGRESS_STEPS.forEach(s => {
      const li = qs(s.id);
      if (li) li.className = 'ob-progress-step';
    });

    let elapsed = 0;
    PROGRESS_STEPS.forEach((step, i) => {
      setTimeout(() => {
        const li = qs(step.id);
        if (!li) return;
        if (i > 0) {
          const prev = qs(PROGRESS_STEPS[i - 1].id);
          if (prev) prev.className = 'ob-progress-step done';
        }
        li.className = 'ob-progress-step active';
      }, elapsed);
      elapsed += step.ms;
    });

    generationPromise.then(() => {
      const last = qs(PROGRESS_STEPS[PROGRESS_STEPS.length - 1].id);
      if (last) last.className = 'ob-progress-step done';
    });
  }

  async function saveProfileAndGenerate() {
    showScreen('s5');
    injectProcessingCopy();

    // Build Q&A payload for DB — map each answer to its field.
    // writing_samples is included here (not sent earlier) so it arrives in the
    // same DB write as Q&A, ensuring extractVoiceDNAFromQA always sees both.
    const qPayload = {
      user_role:                 state.role,
      onboarding_q_completed_at: new Date().toISOString(),
    };
    state.answers.forEach(a => {
      if (a.field && a.answer) qPayload[a.field] = a.answer;
    });
    if (state.writingSample) {
      qPayload.writing_samples = state.writingSample;
    }
    // Hot take (optional contrarian view) — saves to both columns so either
    // prompt builder path can read it without a join.
    if (state.hotTake) {
      qPayload.onboarding_q1   = state.hotTake;
      qPayload.contrarian_view = state.hotTake;
    }
    // Seed starter CTAs so the generation engine never has to invent them.
    // buildVoiceDNABlock() has a hard rule: "never invent a CTA" — this satisfies it
    // for the first post. User refines these in Settings → Stage 4.
    qPayload.cta_library = JSON.stringify([
      'What\'s your take?',
      'Drop a comment below',
      'DM me if this resonates',
    ]);

    // Await the profile save so extractVoiceDNAFromQA (triggered server-side on
    // this save) gets a head start before generation reads the profile.
    // Previously this was fire-and-forget, meaning generation always ran with an
    // empty voice fingerprint. The progress animation starts first so UX is unchanged.
    try {
      await fetch('/api/profile', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify(qPayload),
      });
    } catch {
      // Non-fatal — generation can still proceed
    }

    // Build interview_answers in the legacy format the generate endpoint expects
    const interviewAnswers = state.answers
      .filter(a => a.answer)
      .map(a => ({ question: a.question, answer: a.answer }));

    const genPromise = fetch('/api/generate', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify({
        path:                 'idea',
        interview_answers:    interviewAnswers,
        source:               'onboarding',
        skip_substance_check: true,
      }),
    }).then(r => r.json());

    animateProgress(genPromise);

    let data;
    try {
      data = await genPromise;
    } catch {
      showError('Generation failed. Please go back and try again.');
      return;
    }

    if (!data.ok) {
      showError(data.error || 'Generation failed. Please go back and try again.');
      return;
    }

    state.postId = data.id;
    state.post   = data.post;

    // Small buffer so final progress step is visibly "done" before transitioning
    await new Promise(r => setTimeout(r, 600));

    showScreen('s6');
    fireConfetti();            // fire immediately as screen appears
    await renderPost(data);   // profile fetch runs in parallel
    markOnboardingComplete().catch(() => {});
  }

  function showError(msg) {
    showScreen('s6');
    const errEl = qs('ob-s6-error');
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
  }

  /* ── Screen 6: Post revealed ────────────────────────── */
  async function renderPost(data) {
    const post = data.post || state.post || '';

    const postOut = qs('ob-post-output');
    if (postOut) {
      postOut.value = post;
      requestAnimationFrame(() => autoGrow(postOut));
    }

    // Re-fetch profile to get freshest voice extraction result (may have finished in parallel)
    let freshProfile = {};
    try {
      const profRes = await fetch('/api/profile/' + encodeURIComponent(getUserId()), {
        headers: apiHeaders(),
      });
      const profData = await profRes.json();
      freshProfile = profData.profile || {};
    } catch { /* non-fatal */ }

    // Quality badge
    const qualityBadgeEl = qs('ob-badge-quality');
    if (qualityBadgeEl && data.quality) {
      const score = data.quality.score ?? '';
      qualityBadgeEl.textContent = score
        ? `${data.quality.passed ? '✓ ' : ''}${score}/100 · Ready to publish`
        : 'Quality checked';
    }

    // Hook badge
    const hookBadgeEl = qs('ob-badge-hook');
    if (hookBadgeEl && data.archetypeUsed) {
      hookBadgeEl.textContent = `Hook: ${ARCHETYPE_LABELS[data.archetypeUsed] || data.archetypeUsed}`;
    }

    // Voice badge — three-level fallback: fingerprint.tone → content_niche → role label
    const voiceBadgeEl = qs('ob-badge-voice');
    if (voiceBadgeEl) {
      const fp   = safeParseJSON(freshProfile.voice_fingerprint, {});
      const tone = fp.tone
        || freshProfile.content_niche
        || (state.role && state.role !== 'other' ? ROLE_LABELS[state.role] : null)
        || 'your voice';
      voiceBadgeEl.textContent = `Voice: ${tone}`;
    }

    const badgesEl = qs('ob-badges');
    if (badgesEl) badgesEl.style.display = 'flex';

    renderNextSteps(freshProfile);
  }

  function renderNextSteps(profile) {
    const stepsEl = qs('ob-next-steps');
    const wrapEl  = qs('ob-next-steps-wrap');
    if (!stepsEl || !wrapEl) return;

    const suggestions = [];

    // Missing writing sample — biggest voice quality lever
    if (!state.writingSample) {
      suggestions.push({
        label: 'Add a writing sample — the biggest lever on post quality',
        href:  '/settings.html?step=7',
      });
    }

    // LinkedIn not connected — needed for direct posting
    const hasLinkedIn = (profile.voice_extraction_source || '').includes('linkedin');
    if (!hasLinkedIn) {
      suggestions.push({
        label: 'Connect LinkedIn to post directly without copy-pasting',
        href:  '/linkedin.html',
      });
    }

    // No content pillars set — stops the "what should I write about?" loop
    const hasPillars = isPopulated(profile.content_pillars);
    if (!hasPillars) {
      suggestions.push({
        label: 'Set your content pillars — stop wondering what to write about',
        href:  '/settings.html?step=2',
      });
    }

    const shown = suggestions.slice(0, 2);
    if (shown.length === 0) return;

    stepsEl.innerHTML = shown
      .map(s => `<li><a href="${s.href}">${escHtml(s.label)} →</a></li>`)
      .join('');
    wrapEl.hidden = false;
  }

  function isPopulated(val) {
    if (val === null || val === undefined) return false;
    const t = String(val).trim();
    return t.length > 0 && t !== 'null' && t !== '{}' && t !== '[]';
  }


  /* ── Screen 6: CTAs ──────────────────────────────────── */
  function initS6() {
    qs('ob-open-editor')?.addEventListener('click', () => {
      if (state.postId) {
        window.location.href = `/editor/${state.postId}`;
      } else {
        window.location.href = '/dashboard.html';
      }
    });

    qs('ob-save-drafts')?.addEventListener('click', () => {
      window.location.href = '/dashboard.html';
    });
  }

  function fireConfetti() {
    if (typeof confetti !== 'function') return;
    // Opening salvo — large center blast
    confetti({ particleCount: 400, startVelocity: 55, spread: 100, origin: { x: 0.5, y: 0.6 }, ticks: 180, zIndex: 9999 });
    // Left and right cannons
    setTimeout(() => {
      confetti({ particleCount: 250, startVelocity: 65, spread: 60, angle: 60,  origin: { x: 0,   y: 0.65 }, ticks: 160, zIndex: 9999 });
      confetti({ particleCount: 250, startVelocity: 65, spread: 60, angle: 120, origin: { x: 1,   y: 0.65 }, ticks: 160, zIndex: 9999 });
    }, 150);
    // Follow-through shower
    setTimeout(() => {
      confetti({ particleCount: 200, startVelocity: 40, spread: 120, origin: { x: 0.3, y: 0.5 }, ticks: 140, zIndex: 9999 });
      confetti({ particleCount: 200, startVelocity: 40, spread: 120, origin: { x: 0.7, y: 0.5 }, ticks: 140, zIndex: 9999 });
    }, 400);
    // Final gentle drift
    setTimeout(() => {
      confetti({ particleCount: 150, startVelocity: 20, spread: 140, origin: { x: 0.5, y: 0.4 }, gravity: 0.5, ticks: 200, zIndex: 9999 });
    }, 700);
  }

  /* ── LinkedIn OAuth return handler ───────────────────── */
  function checkLinkedInReturn() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('linkedin') !== 'connected') return false;
    const postId = sessionStorage.getItem('ob_post_id');
    sessionStorage.removeItem('ob_post_id');
    const dest = postId ? `/editor/${postId}` : '/dashboard.html';
    markOnboardingComplete().finally(() => {
      window.location.href = dest;
    });
    return true;
  }

  /* ── Shared helpers ──────────────────────────────────── */
  async function markOnboardingComplete() {
    try {
      await fetch('/api/profile', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify({
          onboarding_complete:     1,
          onboarding_completed_at: new Date().toISOString(),
        }),
      });
    } catch {
      // Non-fatal
    }
  }

  /* ── Init ────────────────────────────────────────────── */
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
      const uid = currentUser.user_id;
      if (uid) {
        const profRes  = await fetch(`/api/profile/${encodeURIComponent(uid)}`, { headers: apiHeaders() });
        const profData = await profRes.json();
        if (profData.profile?.onboarding_complete) {
          window.location.href = '/dashboard.html';
          return;
        }
      }
    } catch {
      // Non-fatal — continue with wizard
    }

    if (checkLinkedInReturn()) return;

    initS1();
    initS2();
    initS4();
    initS6();

    initVoiceInput({ input: document.getElementById('ob-answer'),       btn: document.getElementById('ob-answer-mic') });
    initVoiceInput({ input: document.getElementById('ob-profile-answer'), btn: document.getElementById('ob-profile-mic') });

    showScreen('s1');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Onboarding.init);

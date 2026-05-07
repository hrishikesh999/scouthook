'use strict';

/* ============================================================
   onboarding.js — Scouthook first-time wizard
   6-screen PLG flow:
     s1. Role
     s2. Goal (auto-selects hard_won_lesson template)
     s4. Interview (one question per step)
     s5. Live named progress
     s6. Post revealed + LinkedIn blur gate
     s7. Celebration + vault teaser
   ============================================================ */

const Onboarding = (() => {

  /* ── State ─────────────────────────────────────────────── */
  const state = {
    role:              null,
    goal:              null,
    funnelType:        null,
    templateKey:       null,
    questionIndex:     0,
    answers:           [],   // [{ question, answer }]
    postId:            null,
    post:              null,
    linkedinConnected: false,
  };

  /* ── Interview templates ─────────────────────────────── */
  const TEMPLATES = {
    client_story: {
      label:    'Client Story',
      context:  'A post that takes the reader from where your client started to the result you created together.',
      questions: [
        'What situation was your client in before working with you?',
        'What was the real problem they hadn\'t seen clearly?',
        'What did you do differently from the obvious approach?',
        'What measurable result did they get?',
      ],
    },
    hard_won_lesson: {
      label:    'Hard-Won Lesson',
      context:  'A post built on real experience — your years in the work, a setback that taught you something, and a result that proves you figured it out.',
      questions: [
        'How many years have you been doing this work?',
        'What\'s the biggest mistake or setback you hit early on?',
        'What\'s one result you\'ve achieved that proves you figured it out?',
      ],
    },
    industry_take: {
      label:    'Industry Take',
      context:  'A post that challenges something widely accepted in your field.',
      questions: [
        'What does everyone in your field believe that you think is wrong?',
        'What\'s your evidence — a number, a case, or a pattern you\'ve seen?',
        'What do they miss by believing the conventional view?',
        'What should someone do differently based on your take?',
      ],
    },
  };

  /* ── Archetype metadata ──────────────────────────────── */
  const ARCHETYPE_META = {
    NUMBER:           { desc: 'Opens with a specific number, timeframe, or measurable result' },
    CONTRARIAN:       { desc: 'Challenges a popular belief directly' },
    CONFESSION:       { desc: 'Opens with a personal mistake or failure' },
    PATTERN_INTERRUPT:{ desc: 'A counterintuitive truth under 8 words' },
    DIRECT_ADDRESS:   { desc: 'Speaks directly to a specific person in a specific situation' },
    STAKES:           { desc: 'Opens with consequence or cost before cause or context' },
    BEFORE_AFTER:     { desc: 'Two contrasting states showing a transformation' },
    INSIGHT:          { desc: 'A clean declarative observation about your field' },
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

  /* ── Screen navigation ──────────────────────────────── */
  // Maps screen id → dot number (1–4: role · goal · interview · done)
  const DOT_MAP = { s1: '1', s2: '2', s4: '3', s5: '3', s6: '4', s7: '4' };

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
        setTimeout(() => showScreen('s2'), 200);
      });
    });
  }

  /* ── Screen 2: Goal ─────────────────────────────────── */
  function initS2() {
    qsa('.ob-goal-card').forEach(card => {
      card.addEventListener('click', () => {
        qsa('.ob-goal-card').forEach(c => {
          c.classList.remove('selected');
          c.setAttribute('aria-pressed', 'false');
        });
        card.classList.add('selected');
        card.setAttribute('aria-pressed', 'true');
        state.goal        = card.dataset.goal;
        state.funnelType  = card.dataset.funnel;
        // Skip post-type selection — default to hard_won_lesson (easiest to answer)
        state.templateKey   = 'hard_won_lesson';
        state.questionIndex = 0;
        state.answers       = [];
        const tmpl = TEMPLATES[state.templateKey];
        qs('ob-template-label').textContent   = tmpl.label;
        qs('ob-template-context').textContent = tmpl.context;
        setTimeout(() => {
          showScreen('s4');
          showWebsiteStep();
        }, 200);
      });
    });
  }

  /* ── Screen 4: Interview ────────────────────────────── */
  function showWebsiteStep() {
    qs('ob-website-step').hidden  = false;
    qs('ob-question-step').hidden = true;
    const backBtn = qs('ob-s4-back');
    if (backBtn) backBtn.onclick = () => showScreen('s2');
    qs('ob-website-url')?.focus();
  }

  function showQuestionStep() {
    qs('ob-website-step').hidden  = true;
    qs('ob-question-step').hidden = false;
  }

  function renderQuestion() {
    showQuestionStep();
    const tmpl  = TEMPLATES[state.templateKey];
    const total = tmpl.questions.length;
    const idx   = state.questionIndex;

    qs('ob-q-progress').textContent = `Question ${idx + 1} of ${total}`;
    qs('ob-q-text').textContent     = tmpl.questions[idx];

    const answerEl = qs('ob-answer');
    answerEl.value = state.answers[idx]?.answer || '';
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

    qs('ob-answer-next').textContent = idx === total - 1 ? 'Generate my post →' : 'Next →';
  }

  function initS4() {
    // Website pre-step
    qs('ob-website-next')?.addEventListener('click', submitWebsite);
    qs('ob-website-skip')?.addEventListener('click', () => {
      state.questionIndex = 0;
      renderQuestion();
    });
    qs('ob-website-url')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') submitWebsite();
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

  async function submitWebsite() {
    const input   = qs('ob-website-url');
    const errEl   = qs('ob-website-error');
    const loadEl  = qs('ob-website-loading');
    const nextBtn = qs('ob-website-next');
    const url     = (input?.value || '').trim();

    const valid = /^https?:\/\/.+\..+/.test(url);
    errEl.hidden = valid;
    if (!valid) { input?.focus(); return; }

    nextBtn.disabled = true;
    loadEl.hidden    = false;

    try {
      const res  = await fetch('/api/profile/extract-website', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify({ url }),
      });
      const data = await res.json();
      // Save extracted fields to profile in background — non-blocking
      if (data.ok && data.profile) {
        fetch('/api/profile', {
          method:  'POST',
          headers: apiHeaders(),
          body:    JSON.stringify(data.profile),
        }).catch(() => {});
      }
    } catch {
      // Non-fatal — proceed regardless
    } finally {
      nextBtn.disabled = false;
      loadEl.hidden    = true;
    }

    state.questionIndex = 0;
    renderQuestion();
  }

  function recordAnswer(override) {
    const tmpl = TEMPLATES[state.templateKey];
    const val  = override !== undefined ? override : (qs('ob-answer').value || '').trim();
    state.answers[state.questionIndex] = {
      question: tmpl.questions[state.questionIndex],
      answer:   val,
    };
  }

  function advanceInterview(e, skipping = false) {
    if (!skipping) recordAnswer();
    const tmpl = TEMPLATES[state.templateKey];
    if (state.questionIndex < tmpl.questions.length - 1) {
      state.questionIndex++;
      renderQuestion();
    } else {
      saveProfileAndGenerate();
    }
  }

  /* ── Screen 5: Live progress + generation ───────────── */
  const PROGRESS_STEPS = [
    { id: 'ob-step-1', label: 'Extracting your expertise',     ms: 900 },
    { id: 'ob-step-2', label: 'Selecting the strongest hook',  ms: 1600 },
    { id: 'ob-step-3', label: 'Running quality checks',        ms: 1200 },
    { id: 'ob-step-4', label: 'Finalising your post',          ms: 700  },
  ];

  function animateProgress(generationPromise) {
    // Reset all steps
    PROGRESS_STEPS.forEach(s => {
      const li = qs(s.id);
      if (li) li.className = 'ob-progress-step';
    });

    let elapsed = 0;
    PROGRESS_STEPS.forEach((step, i) => {
      setTimeout(() => {
        const li = qs(step.id);
        if (!li) return;
        // Mark previous as done
        if (i > 0) {
          const prev = qs(PROGRESS_STEPS[i - 1].id);
          if (prev) prev.className = 'ob-progress-step done';
        }
        li.className = 'ob-progress-step active';
      }, elapsed);
      elapsed += step.ms;
    });

    // When generation resolves, mark last step done then transition
    generationPromise.then(() => {
      const last = qs(PROGRESS_STEPS[PROGRESS_STEPS.length - 1].id);
      if (last) last.className = 'ob-progress-step done';
    });
  }

  async function saveProfileAndGenerate() {
    showScreen('s5');

    // Save role + goal to profile (fire and forget — non-blocking)
    fetch('/api/profile', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify({ user_role: state.role, goal: state.goal }),
    }).catch(() => {});

    const genPromise = fetch('/api/generate', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify({
        path:             'idea',
        interview_answers: state.answers,
        funnel_type:       state.funnelType,
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

    renderPost(data);
    showScreen('s6');
  }

  function showError(msg) {
    // Fall back to s6 with an error message visible
    showScreen('s6');
    const errEl = qs('ob-s6-error');
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
  }

  /* ── Screen 6: Post revealed ────────────────────────── */
  function renderPost(data) {
    const post    = data.post || state.post || '';

    const postOut = qs('ob-post-output');
    if (postOut) {
      postOut.value = post;
      autoGrow(postOut);
    }

    // Enable editing
    const editBtn = qs('ob-s6-edit-toggle');
    const postEl  = qs('ob-post-output');
    if (editBtn && postEl) {
      editBtn.hidden = false;
      editBtn.addEventListener('click', () => {
        const isEditing = postEl.readOnly;
        postEl.readOnly = !isEditing;
        editBtn.textContent = isEditing ? 'Lock edits' : 'Edit post';
        if (isEditing) postEl.focus();
      });
    }

    applyPostLock();
  }



  /* ── LinkedIn blur gate ──────────────────────────────── */
  function applyPostLock() {
    if (state.linkedinConnected) return;
    const wrap    = qs('ob-post-wrap');
    const overlay = qs('ob-unlock-overlay');
    const pubBtn  = qs('ob-publish-btn');
    if (!wrap || !overlay) return;

    wrap.classList.add('locked');
    overlay.hidden = false;
    if (pubBtn) pubBtn.hidden = true;

    qs('ob-unlock-cta')?.addEventListener('click', () => {
      sessionStorage.setItem('ob_pending_post', JSON.stringify({
        postId:     state.postId,
        post:       state.post,
        role:       state.role,
        goal:       state.goal,
        funnelType: state.funnelType,
      }));
      window.location.href = '/api/linkedin/connect?from=onboarding';
    }, { once: true });
  }

  function unlockPost() {
    const wrap    = qs('ob-post-wrap');
    const overlay = qs('ob-unlock-overlay');
    const pubBtn  = qs('ob-publish-btn');
    if (wrap)    wrap.classList.remove('locked');
    if (overlay) overlay.hidden = true;
    if (pubBtn)  pubBtn.hidden  = false;
  }

  /* ── Screen 6: Publish ───────────────────────────────── */
  function initS6() {
    qs('ob-publish-btn')?.addEventListener('click', async () => {
      if (!state.linkedinConnected) {
        // Shouldn't happen (button is hidden) but guard anyway
        sessionStorage.setItem('ob_pending_post', JSON.stringify({
          postId: state.postId, post: state.post,
          role: state.role, goal: state.goal, funnelType: state.funnelType,
        }));
        window.location.href = '/api/linkedin/connect?from=onboarding';
        return;
      }

      const btn   = qs('ob-publish-btn');
      const load  = qs('ob-s6-loading');
      const errEl = qs('ob-s6-error');

      btn.disabled  = true;
      load.hidden   = false;
      errEl.hidden  = true;

      const content = (qs('ob-post-output')?.value || state.post || '').trim();

      try {
        const res  = await fetch('/api/linkedin/publish', {
          method:  'POST',
          headers: apiHeaders(),
          body:    JSON.stringify({ content, postId: state.postId }),
        });
        const data = await res.json();

        if (!data.ok) {
          throw new Error(data.error || 'Publish failed');
        }

        await markOnboardingComplete();
        showScreen('s7');
        initS7();
        fireConfetti();
      } catch (err) {
        errEl.textContent = 'Could not publish — please try again.';
        errEl.hidden = false;
        btn.disabled = false;
        load.hidden  = true;
      }
    });
  }

  /* ── Screen 7: Celebration ───────────────────────────── */
  function initS7() {
    const remaining = qs('ob-posts-remaining');
    if (remaining) {
      remaining.textContent = 'You have 4 posts left this month. Post consistently and your next upgrade moment will come naturally.';
    }
    qs('ob-goto-dashboard')?.addEventListener('click', () => {
      window.location.href = '/dashboard.html';
    });
  }

  function fireConfetti() {
    if (typeof confetti !== 'function') return;
    const burst = opts => confetti({ startVelocity: 30, spread: 70, ticks: 80, zIndex: 999, ...opts });
    burst({ particleCount: 80, origin: { x: 0.5, y: 0.55 } });
    setTimeout(() => burst({ particleCount: 50, origin: { x: 0.25, y: 0.6 } }), 220);
    setTimeout(() => burst({ particleCount: 50, origin: { x: 0.75, y: 0.6 } }), 380);
  }

  /* ── LinkedIn OAuth return handler ───────────────────── */
  function checkLinkedInReturn() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('linkedin') !== 'connected') return false;

    const saved = sessionStorage.getItem('ob_pending_post');
    if (saved) {
      try {
        const pending = JSON.parse(saved);
        sessionStorage.removeItem('ob_pending_post');
        state.postId          = pending.postId;
        state.post            = pending.post;
        state.role            = pending.role;
        state.goal            = pending.goal;
        state.funnelType      = pending.funnelType;
        state.linkedinConnected = true;
        history.replaceState({}, '', '/onboarding.html');
        renderPost(state);
        unlockPost();
        initS6();
        showScreen('s6');
        return true;
      } catch {
        sessionStorage.removeItem('ob_pending_post');
      }
    }

    // No pending post — mark complete and go to dashboard
    markOnboardingComplete().finally(() => {
      window.location.href = '/dashboard.html';
    });
    return true;
  }

  /* ── Shared helpers ──────────────────────────────────── */
  async function markOnboardingComplete() {
    try {
      await fetch('/api/profile', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify({ onboarding_complete: 1 }),
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

    // Prefetch LinkedIn status so Screen 6 blur gate has the answer ready
    fetch('/api/linkedin/status', { headers: apiHeaders() })
      .then(r => r.json())
      .then(d => { if (d.connected) state.linkedinConnected = true; })
      .catch(() => {});

    // Wire back buttons
    qsa('.ob-back-btn[data-back-to]').forEach(btn => {
      btn.addEventListener('click', () => showScreen(btn.dataset.backTo));
    });

    initS1();
    initS2();
    initS4();
    initS6();

    showScreen('s1');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Onboarding.init);

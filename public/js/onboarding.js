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
      questions: [
        'What first drew you to this kind of work?',
        'What took you the longest to figure out?',
        'What is one result from your work that you are genuinely proud of?',
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
    qs('ob-website-summary').hidden = true;
    qs('ob-profile-step').hidden    = true;
    qs('ob-question-step').hidden   = true;
    const backBtn = qs('ob-s4-back');
    if (backBtn) backBtn.onclick = () => showScreen('s2');
    qs('ob-website-url')?.focus();
  }

  function showProfileStep() {
    qs('ob-website-step').hidden    = true;
    qs('ob-website-summary').hidden = true;
    qs('ob-profile-step').hidden    = false;
    qs('ob-question-step').hidden   = true;
    const backBtn = qs('ob-s4-back');
    if (backBtn) backBtn.onclick = () => showWebsiteStep();
    qs('ob-profile-answer')?.focus();
  }

  function submitProfileQuestion() {
    const val = (qs('ob-profile-answer')?.value || '').trim();
    if (val) {
      fetch('/api/profile', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify({ content_niche: val }),
      }).catch(() => {});
    }
    state.questionIndex = 0;
    renderQuestion();
  }

  function buildNarrative(e) {
    const parts = [];

    if (e.content_niche) {
      const niche = e.content_niche.replace(/^helping\s+/i, 'You help ');
      parts.push(niche.match(/[.!?]$/) ? niche : niche + '.');
    } else if (e.audience_role) {
      parts.push(`You work with ${e.audience_role}.`);
    }

    if (e.audience_pain) {
      const pain = e.audience_pain.replace(/[.!?]$/, '');
      parts.push(`The challenge they face: ${pain.charAt(0).toLowerCase() + pain.slice(1)}.`);
    }

    if (e.contrarian_view) {
      const take = e.contrarian_view.replace(/[.!?]$/, '');
      parts.push(`Your edge: ${take.charAt(0).toLowerCase() + take.slice(1)}.`);
    }

    return parts.join(' ');
  }

  function showSummaryStep(extracted) {
    const LABELS = {
      content_niche:   'What you do',
      audience_role:   'Who you help',
      audience_pain:   'Their main challenge',
      contrarian_view: 'Your take',
    };

    const card = qs('ob-narrative-card');
    if (card) card.textContent = buildNarrative(extracted);

    const fields = qs('ob-summary-fields');
    fields.innerHTML = '';
    Object.entries(LABELS).forEach(([key, label]) => {
      if (!extracted[key]) return;
      const wrap = document.createElement('div');
      wrap.className = 'ob-summary-field';
      wrap.innerHTML = `<label class="ob-summary-label">${label}</label>
        <textarea class="ob-textarea ob-textarea--summary" data-key="${key}" rows="2">${escHtml(extracted[key])}</textarea>`;
      fields.appendChild(wrap);
    });

    qs('ob-website-step').hidden    = true;
    qs('ob-profile-step').hidden    = true;
    qs('ob-website-summary').hidden = false;
    qs('ob-question-step').hidden   = true;

    // Fields hidden by default — revealed by toggle
    const fieldsEl = qs('ob-summary-fields');
    if (fieldsEl) fieldsEl.hidden = true;
    const toggle = qs('ob-summary-edit-toggle');
    if (toggle) {
      toggle.onclick = () => {
        if (!fieldsEl) return;
        fieldsEl.hidden = !fieldsEl.hidden;
        toggle.textContent = fieldsEl.hidden ? 'Edit details ↓' : 'Hide details ↑';
      };
    }

    const backBtn = qs('ob-s4-back');
    if (backBtn) backBtn.onclick = () => showWebsiteStep();
  }

  function showQuestionStep() {
    qs('ob-website-step').hidden    = true;
    qs('ob-website-summary').hidden = true;
    qs('ob-profile-step').hidden    = true;
    qs('ob-question-step').hidden   = false;
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
    qs('ob-website-skip')?.addEventListener('click', showProfileStep);
    qs('ob-website-url')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') submitWebsite();
    });

    // Summary confirm
    qs('ob-summary-confirm')?.addEventListener('click', confirmSummary);

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

    let extracted = {};
    try {
      const res  = await fetch('/api/profile/extract-website', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify({ url }),
      });
      const data = await res.json();
      if (data.ok) {
        const { content_niche, audience_role, audience_pain, contrarian_view } = data;
        extracted = { content_niche, audience_role, audience_pain, contrarian_view };
      }
    } catch {
      // Non-fatal — fall through to Q1
    } finally {
      nextBtn.disabled = false;
      loadEl.hidden    = true;
    }

    const hasAny = Object.values(extracted).some(v => v);
    if (hasAny) {
      showSummaryStep(extracted);
    } else {
      state.questionIndex = 0;
      renderQuestion();
    }
  }

  function confirmSummary() {
    const profile = {};
    qs('ob-summary-fields').querySelectorAll('textarea[data-key]').forEach(el => {
      const val = el.value.trim();
      if (val) profile[el.dataset.key] = val;
    });
    if (Object.keys(profile).length) {
      fetch('/api/profile', {
        method:  'POST',
        headers: apiHeaders(),
        body:    JSON.stringify(profile),
      }).catch(() => {});
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

    showScreen('s6');
    renderPost(data);
    fireConfetti();
    markOnboardingComplete().catch(() => {});
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
      // autoGrow needs the element to be visible — defer one frame
      requestAnimationFrame(() => autoGrow(postOut));
    }

  }

  /* ── Screen 6: editor CTA + LinkedIn strip ──────────── */
  function initS6() {
    qs('ob-open-editor')?.addEventListener('click', () => {
      const dest = state.postId
        ? `/preview.html?post_id=${state.postId}`
        : '/preview.html';
      window.location.href = dest;
    });

    qs('ob-connect-linkedin')?.addEventListener('click', () => {
      window.location.href = '/api/linkedin/connect?from=onboarding';
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
    // Onboarding is already complete at this point — just go to dashboard
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

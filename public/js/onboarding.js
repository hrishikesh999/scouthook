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
  };

  /* ── Interview questions ─────────────────────────────────
     Three fixed questions in order. context is the badge shown above each.
     field is the DB column the answer writes to (plus special handling for q1 → contrarian_view).
  ──────────────────────────────────────────────────────── */
  const QUESTIONS = [
    {
      context:     'Your POV — This shapes the perspective behind every post we write for you.',
      text:        'What do most people in your field get wrong — and what do you believe instead?',
      hint:        'Your honest take. The more specific, the better.',
      placeholder: 'e.g. Most consultants lead with methodology. I think that\'s backwards — clients need to see a specific outcome first.',
      field:       'onboarding_q1',
    },
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
    NUMBER:           'Number hook',
    CONTRARIAN:       'Contrarian',
    CONFESSION:       'Confession',
    PATTERN_INTERRUPT:'Pattern interrupt',
    DIRECT_ADDRESS:   'Direct address',
    STAKES:           'Stakes',
    BEFORE_AFTER:     'Before/After',
    INSIGHT:          'Insight',
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
  // Maps screen id → progress dot number (1–4)
  // s4 covers both website and questions (dot 2)
  // s5 is generating (dot 3), s6 is reveal (dot 4)
  const DOT_MAP = { s1: '1', s4: '2', s3: '3', s5: '4', s6: '5' };

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
    qs('ob-website-summary').hidden = true;
    qs('ob-profile-step').hidden    = true;
    qs('ob-question-step').hidden   = true;
    const backBtn = qs('ob-s4-back');
    if (backBtn) backBtn.onclick = () => showScreen('s1');
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
      content_niche:        'What you do',
      audience_role:        'Who you help',
      audience_pain:        'Their main challenge',
      contrarian_view:      'Your take',
      business_positioning: 'How you help them',
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
    const q     = QUESTIONS[state.questionIndex];
    const total = QUESTIONS.length;
    const idx   = state.questionIndex;

    qs('ob-q-progress').textContent = `Question ${idx + 1} of ${total}`;
    qs('ob-q-context').textContent  = q.context;
    qs('ob-q-text').textContent     = q.text;
    const hintEl = qs('ob-q-hint');
    if (hintEl) hintEl.textContent  = q.hint || '';

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
        const { content_niche, audience_role, audience_pain, contrarian_view, business_positioning } = data;
        extracted = { content_niche, audience_role, audience_pain, contrarian_view, business_positioning };
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
      showScreen('s3');
    }
  }

  /* ── Screen 3: Vault upload ─────────────────────────── */
  function initS3() {
    const dropzone  = qs('ob-vault-dropzone');
    const fileInput = qs('ob-vault-file');
    const fileBadge = qs('ob-vault-file-badge');
    const fileName  = qs('ob-vault-file-name');
    const fileClear = qs('ob-vault-file-clear');
    const urlInput  = qs('ob-vault-url');
    const uploadBtn = qs('ob-vault-upload-btn');
    const skipBtn   = qs('ob-vault-skip-btn');
    const statusEl  = qs('ob-vault-status');

    let pendingFile = null;

    function setStatus(msg, type) {
      if (!statusEl) return;
      statusEl.textContent   = msg;
      statusEl.style.display = msg ? '' : 'none';
      statusEl.className     = type === 'error' ? 'ob-field-error' : '';
    }

    function selectFile(f) {
      const ok = /\.(pdf|docx|txt)$/i.test(f.name);
      if (!ok) { setStatus('Only PDF, DOCX, or TXT files are supported.', 'error'); return; }
      pendingFile = f;
      if (fileName)   fileName.textContent    = f.name;
      if (fileBadge)  fileBadge.style.display = '';
      if (dropzone)   dropzone.style.display  = 'none';
      if (urlInput)   urlInput.value          = '';
      setStatus('', '');
    }

    dropzone?.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('dragging'); });
    dropzone?.addEventListener('dragleave', ()  => dropzone.classList.remove('dragging'));
    dropzone?.addEventListener('drop', e => {
      e.preventDefault(); dropzone.classList.remove('dragging');
      const f = e.dataTransfer.files[0]; if (f) selectFile(f);
    });
    // Keyboard access: label handles click natively; keydown fires explicit click for Enter/Space
    dropzone?.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput?.click(); }
    });
    fileInput?.addEventListener('change', () => { if (fileInput.files[0]) selectFile(fileInput.files[0]); });

    fileClear?.addEventListener('click', e => {
      e.stopPropagation();
      pendingFile = null;
      if (fileBadge) fileBadge.style.display = 'none';
      if (dropzone)  dropzone.style.display  = '';
      if (fileInput) fileInput.value         = '';
      if (urlInput)  urlInput.value          = '';
      setStatus('', '');
    });

    skipBtn?.addEventListener('click', () => saveProfileAndGenerate());

    uploadBtn?.addEventListener('click', async () => {
      const url = (urlInput?.value || '').trim();
      if (!pendingFile && !url) { saveProfileAndGenerate(); return; }

      uploadBtn.disabled = true;
      setStatus('Uploading…', '');

      try {
        let res, data;
        if (pendingFile) {
          res  = await fetch('/api/vault/upload', {
            method:  'POST',
            headers: { ...apiHeaders(), 'Content-Type': pendingFile.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(pendingFile.name) },
            body:    pendingFile,
          });
          data = await res.json();
        } else {
          res  = await fetch('/api/vault/upload', {
            method:  'POST',
            headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
            body:    JSON.stringify({ url }),
          });
          data = await res.json();
        }

        if (data.ok) {
          state.vaultDocId = data.document?.id || null;
          // Trigger mining in background so vault ideas are ready for next session
          fetch('/api/vault/mine', { method: 'POST', headers: apiHeaders() }).catch(() => {});
          setStatus('', '');
        } else {
          if (data.error === 'plan_limit_exceeded') {
            setStatus('Vault limit reached on your current plan. Continuing without upload.', 'error');
          } else {
            setStatus('Upload failed — continuing without it.', 'error');
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      } catch {
        setStatus('Upload failed — continuing without it.', 'error');
        await new Promise(r => setTimeout(r, 1500));
      }

      uploadBtn.disabled = false;
      saveProfileAndGenerate();
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

    // Build Q&A payload for DB — map each answer to its field
    const qPayload = {
      user_role:                 state.role,
      onboarding_q_completed_at: new Date().toISOString(),
    };
    state.answers.forEach(a => {
      if (a.field && a.answer) qPayload[a.field] = a.answer;
    });
    // Q1 also writes to contrarian_view for backward compat with prompt builders
    if (qPayload.onboarding_q1) {
      qPayload.contrarian_view = qPayload.onboarding_q1;
    }

    // Save role + Q&A answers to profile (fire-and-forget)
    fetch('/api/profile', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify(qPayload),
    }).catch(() => {});

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
    initS3();
    initS4();
    initS6();

    showScreen('s1');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Onboarding.init);

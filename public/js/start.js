/* ===========================================================================
   start.js — the /start first-post flow.

   Sign in (identity scope only) → one question → generate → the post.

   The seven-screen brand interview still exists at /onboarding.html; it moves
   to AFTER the post, where each ask is paid for by output the user has read.
   The bet is that time-to-first-output, not profile completeness, is what
   activates people — see the 19%-complete voice profiles on users who never
   generated anything.
   =========================================================================== */

'use strict';

const SCREENS = ['signin', 'ask', 'more', 'cook', 'post', 'earn'];

const state = {
  name: null,
  photo: null,
  headline: null,
  canPublish: false,
  answer: '',
  followUp: '',
  postId: null,
  postText: '',
  hookLifted: false,
  retentionOk: true,
  retentionScore: 0,
  gatePassed: true,
};

// ── Screens ─────────────────────────────────────────────────────────────────

function show(id) {
  SCREENS.forEach((s) => {
    document.getElementById('st-' + s)?.classList.toggle('active', s === id);
  });
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function showError(elId, message) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function clearError(elId) {
  const el = document.getElementById(elId);
  if (el) el.hidden = true;
}

function setLoading(btn, on, label) {
  if (!btn) return;
  btn.disabled = on;
  if (on) {
    btn.dataset.label = btn.textContent;
    if (label) btn.textContent = label;
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
  }
}

// ── LinkedIn status ─────────────────────────────────────────────────────────

async function loadLinkedInStatus() {
  try {
    const r = await fetch('/api/linkedin/status', { credentials: 'same-origin' });
    const d = await r.json();
    if (!d.connected) return false;

    state.name = d.name || null;
    state.photo = d.photo_url || null;
    state.headline = d.headline || null;
    state.canPublish = !!d.can_publish;
    return true;
  } catch (_) {
    return false;
  }
}

function paintIdentity() {
  const first = (state.name || '').trim().split(/\s+/)[0] || '';

  const askH = document.getElementById('st-ask-h');
  if (askH) askH.textContent = first ? `Got it, ${first}. One question.` : 'One question.';

  const nameEl = document.getElementById('st-ident-name');
  if (nameEl) nameEl.textContent = state.name || '';

  const headEl = document.getElementById('st-ident-headline');
  if (headEl) headEl.textContent = state.headline || '';

  const photoEl = document.getElementById('st-ident-photo');
  if (photoEl && state.photo) {
    photoEl.src = state.photo;
    photoEl.alt = state.name || '';
    photoEl.hidden = false;
  }

  const pName = document.getElementById('st-preview-name');
  if (pName) pName.textContent = state.name || 'You';

  const pPhoto = document.getElementById('st-preview-photo');
  if (pPhoto && state.photo) {
    pPhoto.src = state.photo;
    pPhoto.alt = '';
    pPhoto.hidden = false;
  }
}

// ── Voice input ─────────────────────────────────────────────────────────────
// Progressive enhancement: the mic only appears where the browser supports it,
// and the textarea is always present as the path for everyone else.

function initVoice(ids) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = document.getElementById(ids.mic);
  const orEl = document.getElementById(ids.or);
  const waveEl = document.getElementById(ids.wave);
  const listenEl = document.getElementById(ids.listening);
  const answerEl = document.getElementById(ids.answer);
  const micLabel = document.getElementById(ids.label);

  if (!SR || !micBtn) return;

  micBtn.hidden = false;
  if (orEl) orEl.hidden = false;

  const recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  let listening = false;
  let committed = '';

  function stopUI() {
    listening = false;
    micBtn.classList.remove('recording');
    if (micLabel) micLabel.textContent = 'Just say it';
    if (waveEl) waveEl.hidden = true;
    if (listenEl) listenEl.hidden = true;
  }

  micBtn.addEventListener('click', () => {
    if (listening) { recognition.stop(); stopUI(); return; }
    committed = answerEl.value ? answerEl.value.trim() + ' ' : '';
    try {
      recognition.start();
    } catch (_) {
      // start() throws if called while already running — treat as a no-op.
      return;
    }
    listening = true;
    micBtn.classList.add('recording');
    if (micLabel) micLabel.textContent = 'Done';
    if (waveEl) waveEl.hidden = false;
    if (listenEl) listenEl.hidden = false;
  });

  // Words land in the textarea as they're spoken — this is what proves the mic
  // is live, so nobody talks for thirty seconds into a dead microphone.
  recognition.addEventListener('result', (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript;
      if (e.results[i].isFinal) committed += chunk + ' ';
      else interim += chunk;
    }
    answerEl.value = (committed + interim).replace(/\s+/g, ' ').trimStart();
    answerEl.dispatchEvent(new Event('input'));
  });

  recognition.addEventListener('end', stopUI);
  recognition.addEventListener('error', (e) => {
    stopUI();
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      showError(ids.error, 'We couldn’t reach your microphone. Check your browser’s mic permission, or type your answer below.');
    }
  });
}

// ── Cooking lines ───────────────────────────────────────────────────────────

const COOK_LINES = [
  'Reading your LinkedIn headline',
  'Finding the hook in your story',
  'Drafting your post',
  'Making sure it doesn’t sound like AI',
];

let cookTimer = null;

function startCookLines() {
  const el = document.getElementById('st-cookline');
  const dots = document.getElementById('st-cookdots')?.querySelectorAll('span') || [];
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let i = 0;

  const paint = () => {
    if (!el) return;
    el.textContent = COOK_LINES[i];
    dots.forEach((d, n) => d.classList.toggle('on', n === i));
    if (reduce) return;
    el.classList.remove('swap');
    void el.offsetWidth; // force reflow so the animation restarts
    el.classList.add('swap');
  };

  paint();
  stopCookLines();
  cookTimer = setInterval(() => {
    // Hold on the last line rather than looping — a second pass would signal
    // that generation has stalled.
    if (i < COOK_LINES.length - 1) { i += 1; paint(); }
  }, 2600);
}

function stopCookLines() {
  if (cookTimer) { clearInterval(cookTimer); cookTimer = null; }
}

// ── Confetti ────────────────────────────────────────────────────────────────

const CONFETTI_COLORS = ['#0F766E', '#10B981', '#F59E0B', '#EF4444', '#3B82F6', '#EC4899', '#84CC16', '#FBBF24'];

function fireConfetti() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = document.getElementById('st-confetti');
  if (!canvas) return;

  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const parts = [];
  for (let i = 0; i < 180; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 3 + Math.random() * 9;
    parts.push({
      x: w / 2 + (Math.random() - 0.5) * 60,
      y: h * 0.3 + (Math.random() - 0.5) * 30,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 5,
      w: 5 + Math.random() * 7,
      h: 3 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.34,
      color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
      life: 0,
      max: 120 + Math.random() * 70,
    });
  }

  (function frame() {
    ctx.clearRect(0, 0, w, h);
    let alive = 0;

    for (const p of parts) {
      if (p.life > p.max) continue;
      p.life += 1;
      p.vy += 0.18;
      p.vx *= 0.991;
      p.vy *= 0.991;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y - 20 > h) continue;
      alive += 1;

      const fade = p.life > p.max - 45 ? (p.max - p.life) / 45 : 1;
      ctx.save();
      ctx.globalAlpha = Math.max(0, fade);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }

    if (alive > 0) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, w, h);
  })();
}

// ── Generation ──────────────────────────────────────────────────────────────

async function generate() {
  clearError('st-ask-error');
  show('cook');
  startCookLines();

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_idea: combinedAnswer(),
        // Let the server read the answer and pick the shape. Hardcoding 'reach'
        // gave the editor the vaguest instruction available ("whatever fits"),
        // wasting the one line that tells it what to LEAD with.
        post_type: 'auto',
        source: 'start_flow',
        // No length_preference on purpose. The default is "match what they gave
        // you", which is the right rule for a spoken answer — a fixed 'short'
        // ceiling throws away material the author actually provided.
        // Retry once against the fidelity floor if the first pass composes rather
        // than organises. Only surfaces that claim "your words" turn this on.
        enforce_retention: true,
        // generation_mode is deliberately NOT set. The server's input router
        // classifies the answer and picks the path: 40+ words of the author's own
        // material goes to organizePost (editor — keeps their words), anything
        // shorter is a 'seed' and goes to guided generation, which is built for
        // the blank page. Forcing 'organize' on a one-liner makes the editor
        // invent the other 80% of the post and ship it — retention failures only
        // console.warn, they don't block — which is precisely the AI slop this
        // whole flow exists to avoid.
      }),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok || !data?.ok) {
      stopCookLines();
      show('ask');
      showError('st-ask-error', generationErrorMessage(res.status, data));
      return;
    }

    // Safety net, in two halves — they catch opposite failures and neither alone
    // is enough:
    //   retention_ok false → the editor composed rather than organised. Showing
    //     that framed as "your words" is a lie the reader can feel.
    //   quality.passed false → the post is faithful but too thin to be a post.
    //     Measured: an 11-word answer now yields a perfectly honest 11-word post
    //     at retention 1.0 that the gate scores 30. Fidelity enforcement stops
    //     fabrication; it cannot manufacture material. Only asking can.
    // Either way the fix is the same, and only if we haven't already asked.
    const fabricated = data.retention_ok === false;
    const tooThin = data.quality && data.quality.passed === false;
    if ((fabricated || tooThin) && !state.followUp) {
      stopCookLines();
      showFollowUp();
      showError('st-more-error', fabricated
        ? 'We had to put too many of our own words in that one. One example and it’ll sound like you.'
        : 'There wasn’t quite enough there to build a post from. One example and we’re set.');
      return;
    }

    state.postId = data.id || null;
    state.postText = data.post || '';
    // hook_was_written is the server's measurement of which rung the editor used,
    // not the model's self-report — so the provenance line can't overclaim.
    state.hookLifted = data.hook_was_written === false;
    state.retentionOk = data.retention_ok !== false;
    state.retentionScore = (data.retention && typeof data.retention.score === 'number') ? data.retention.score : 0;
    state.gatePassed = !data.quality || data.quality.passed !== false;

    stopCookLines();
    paintPost();
    show('post');
    setTimeout(fireConfetti, 220);
  } catch (_) {
    stopCookLines();
    show('ask');
    showError('st-ask-error', 'Something went wrong writing your post. Try again in a moment.');
  }
}

function generationErrorMessage(status, data) {
  if (status === 429 && data?.error === 'monthly_quota_reached') {
    return 'You’ve used all the posts on your plan this month.';
  }
  if (status === 429) return 'That was quick — give it a few seconds and try again.';
  return 'Something went wrong writing your post. Try again in a moment.';
}

// How rare posting actually is. Left null on purpose: every "only N% of LinkedIn
// users post" figure in circulation traces back to marketing blogs, not LinkedIn,
// and an unverifiable statistic on the screen where we're asking for posting
// permission undercuts the checkable honesty that got the user this far. Set it
// to a number (e.g. 1) once there's a source you'd be happy to be quoted on and
// the percentage framing renders automatically.
const POSTING_PERCENTILE = null;

function paintPost() {
  const body = document.getElementById('st-preview-body');
  if (body) body.textContent = state.postText;
  paintVerdict();
  paintRarity();
  paintProvenance();
}

// Deliberately NOT the gate score. runQualityGate is an integrity check —
// "a clean post scores 100 with a null verdict" — so it returns 100 on nearly
// everything, including (measured) a post with retention 0.26 and 29 invented
// words. A badge driven by it would read "Excellent" every time, which users
// learn to ignore by their second post and which would have praised slop.
//
// So the verdict is a composite of the three signals that actually vary:
// the gate passing, how much of the post is the author's, and whether the
// opening line is theirs. When none of that clears, no badge at all — silence
// is honest, and an absent badge is far cheaper than a devalued one.
function paintVerdict() {
  const el = document.getElementById('st-verdict');
  if (!el) return;

  const gateOk = state.gatePassed !== false;
  let tier = null;

  if (gateOk && state.retentionOk && state.retentionScore >= 0.85 && state.hookLifted) {
    tier = { cls: 'excellent', label: 'Excellent' };
  } else if (gateOk && state.retentionOk) {
    tier = { cls: 'strong', label: 'Strong' };
  }

  if (!tier) { el.hidden = true; return; }
  el.className = 'st-verdict st-verdict--' + tier.cls;
  el.innerHTML =
    '<span class="st-verdict-label">Post quality</span>' +
    '<span class="st-verdict-value">' + tier.label + '</span>';
  el.hidden = false;
}

// Future tense, not "you are among" — they haven't posted yet, and telling
// someone they already did the thing they're hesitating over is the one claim
// on this screen they can immediately falsify.
function paintRarity() {
  const el = document.getElementById('st-rarity');
  if (!el) return;
  const line = POSTING_PERCENTILE
    ? `You're about to join the <b>${POSTING_PERCENTILE}%</b> of people who actually post on LinkedIn.`
    : 'Most people never post. You\'re about to be one of the few who do.';
  // <mark> is the right element here — this is highlighted for relevance, not
  // emphasis — and it carries the highlighter styling in start.css.
  el.innerHTML = `<span class="st-rarity-icon" aria-hidden="true">🏆</span><mark>${line}</mark>`;
}

// The strongest thing we can say at the publish moment is the one thing the
// reader can verify in two seconds: that these are their own words. So it is
// stated only when the measurement supports it, and never as a general boast.
//
//   hook lifted           → the checkable version, naming the opening line
//   hook composed, but
//   high retention        → the weaker, still-true version about the body
//   neither               → say nothing. An unearned fidelity claim on a post
//                           the model largely wrote is exactly the kind of
//                           thing a reader catches, and it costs more than
//                           silence ever would.
function paintProvenance() {
  const el = document.getElementById('st-provenance');
  if (!el) return;

  if (state.hookLifted) {
    el.innerHTML = '<span aria-hidden="true">✎</span><span>That opening line is <b>yours, word for word</b> — we changed the order, not the words.</span>';
    el.hidden = false;
    return;
  }
  if (state.retentionOk) {
    el.innerHTML = '<span aria-hidden="true">✎</span><span>Built from <b>what you just said</b> — your words, reordered for the feed.</span>';
    el.hidden = false;
    return;
  }
  el.hidden = true;
}

// ── Surviving the OAuth round-trip ──────────────────────────────────────────
// Asking for the write scope navigates away to LinkedIn and back, which reloads
// this page and would otherwise lose the generated post. sessionStorage is the
// right lifetime here: it dies with the tab, so a returning user never gets an
// unrelated stale post from a previous visit.

const STASH_KEY = 'st_pending_post';

function stashPost() {
  try {
    sessionStorage.setItem(STASH_KEY, JSON.stringify({ id: state.postId, text: state.postText, hookLifted: state.hookLifted, retentionOk: state.retentionOk, retentionScore: state.retentionScore, gatePassed: state.gatePassed }));
  } catch (_) { /* private mode — the post is still saved server-side in Drafts */ }
}

function readStash() {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && d.text ? d : null;
  } catch (_) {
    return null;
  }
}

function clearStash() {
  try { sessionStorage.removeItem(STASH_KEY); } catch (_) { /* nothing to clear */ }
}

// ── Publish ─────────────────────────────────────────────────────────────────

async function publish() {
  clearError('st-post-error');

  // The /start sign-in only carries the identity scope, so the write scope is
  // requested here — at the one moment where posting-on-your-behalf explains
  // itself, because there is a finished post on screen.
  if (!state.canPublish) {
    // Granting the write scope means a full round-trip to LinkedIn and back, which
    // reloads this page. Stash the post so the user returns to it rather than to a
    // blank question they've already answered.
    stashPost();
    document.getElementById('st-modal').hidden = false;
    return;
  }

  const btn = document.getElementById('st-publish');
  setLoading(btn, true, 'Posting…');

  try {
    const res = await fetch('/api/linkedin/publish', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId: state.postId, content: state.postText }),
    });
    const data = await res.json().catch(() => null);

    if (!res.ok || !data?.ok) {
      setLoading(btn, false);
      if (data?.error === 'publish_scope_required') {
        state.canPublish = false;
        document.getElementById('st-modal').hidden = false;
        return;
      }
      showError('st-post-error', 'We couldn’t publish that just now. Your post is saved in Drafts — you can publish it from there.');
      return;
    }

    show('earn');
  } catch (_) {
    setLoading(btn, false);
    showError('st-post-error', 'We couldn’t publish that just now. Your post is saved in Drafts — you can publish it from there.');
  }
}

async function copyPost() {
  try {
    await navigator.clipboard.writeText(state.postText);
    const btn = document.getElementById('st-modal-copy');
    if (btn) {
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy the post instead'; }, 2000);
    }
  } catch (_) {
    showError('st-post-error', 'Couldn’t copy automatically — select the post text above and copy it.');
  }
  document.getElementById('st-modal').hidden = true;
  show('earn');
}

// ── Wiring ──────────────────────────────────────────────────────────────────

// ── Fidelity nudge ──────────────────────────────────────────────────────────
// Under the router's raw threshold the answer is a 'seed', and the post gets
// composed rather than built from the author's own words. That still works, but
// it's the version most likely to read as generic. So we say so — once, quietly,
// without blocking, because a forced word count would cost more than it earns.

function updateNudge() {
  const el = document.getElementById('st-nudge');
  const answerEl = document.getElementById('st-answer');
  if (!el || !answerEl || !window.InputMaturity) return;

  const { countWords, RAW_MIN_WORDS } = window.InputMaturity;
  const words = countWords(answerEl.value);

  if (words === 0 || words >= RAW_MIN_WORDS) {
    el.hidden = true;
    return;
  }
  el.textContent = 'A little more and we can build the post out of your own words — another line or two does it.';
  el.hidden = false;
}

// Below the router's raw threshold the editor would have to invent most of the
// post, so ask instead of generating. Measured: 11 words → retention 0.26 with 29
// invented words, and the quality gate passes it at 100. Asking one more question
// is the only thing that actually fixes it — a retry has no more material to work
// with than the first attempt did.
function needsMoreMaterial(text) {
  if (!window.InputMaturity) return false;
  return window.InputMaturity.countWords(text) < window.InputMaturity.RAW_MIN_WORDS;
}

function showFollowUp() {
  const echo = document.getElementById('st-echo');
  if (echo) echo.textContent = '“' + state.answer + '”';
  show('more');
  document.getElementById('st-answer2')?.focus();
}

/** The author's material for this post — both answers when we asked twice. */
function combinedAnswer() {
  return state.followUp ? `${state.answer}\n\n${state.followUp}` : state.answer;
}

function initEvents() {
  document.getElementById('st-go')?.addEventListener('click', () => {
    const val = document.getElementById('st-answer').value.trim();
    if (val.length < 10) {
      showError('st-ask-error', 'Give us a sentence or two to work with.');
      return;
    }
    state.answer = val;
    clearError('st-ask-error');
    if (needsMoreMaterial(val)) { showFollowUp(); return; }
    generate();
  });

  document.getElementById('st-more-go')?.addEventListener('click', () => {
    const val = document.getElementById('st-answer2').value.trim();
    if (val.length < 10) {
      showError('st-more-error', 'A line or two on what happened is all we need.');
      return;
    }
    state.followUp = val;
    clearError('st-more-error');
    generate();
  });

  // They can still refuse. The post will be more composed than organised, which
  // is worse but not broken — the server's router sends a seed to guided
  // generation, the path built for the blank page.
  document.getElementById('st-more-skip')?.addEventListener('click', () => {
    state.followUp = '';
    generate();
  });

  document.getElementById('st-answer')?.addEventListener('input', updateNudge);

  document.getElementById('st-retry')?.addEventListener('click', () => generate());

  document.getElementById('st-edit')?.addEventListener('click', () => {
    window.location.href = state.postId ? `/editor.html?postId=${state.postId}` : '/drafts.html';
  });

  document.getElementById('st-publish')?.addEventListener('click', publish);
  document.getElementById('st-modal-copy')?.addEventListener('click', copyPost);

  document.getElementById('st-earn-go')?.addEventListener('click', () => {
    window.location.href = '/onboarding.html';
  });
  document.getElementById('st-earn-later')?.addEventListener('click', () => {
    window.location.href = '/drafts.html';
  });

  // Cmd/Ctrl+Enter submits from the textarea — a plain Enter has to stay
  // available for line breaks in a free-text answer.
  document.getElementById('st-answer')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      document.getElementById('st-go')?.click();
    }
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────

(async function boot() {
  initEvents();
  initVoice({ mic: 'st-mic',  label: 'st-mic-label',  wave: 'st-wave',  listening: 'st-listening',  or: 'st-or',  answer: 'st-answer',  error: 'st-ask-error' });
  initVoice({ mic: 'st-mic2', label: 'st-mic2-label', wave: 'st-wave2', listening: 'st-listening2', or: 'st-or2', answer: 'st-answer2', error: 'st-more-error' });

  const params = new URLSearchParams(window.location.search);
  const oauthError = params.get('linkedin_error');
  const justConnected = params.get('linkedin') === 'connected';

  if (justConnected || oauthError) {
    history.replaceState({}, '', window.location.pathname);
  }

  const connected = await loadLinkedInStatus();
  document.getElementById('st-init').style.display = 'none';

  if (oauthError) {
    show('signin');
    showError('st-signin-error', 'That didn’t go through. Try connecting again — nothing was shared.');
    return;
  }

  if (!connected) {
    show('signin');
    return;
  }

  paintIdentity();

  // Returning from the write-scope grant with the post we generated before the
  // redirect: put them back on it, ready to publish, instead of a blank question
  // they've already answered.
  const stashed = readStash();
  if (stashed) {
    clearStash();
    state.postId = stashed.id;
    state.postText = stashed.text;
    state.hookLifted = !!stashed.hookLifted;
    state.retentionOk = stashed.retentionOk !== false;
    state.retentionScore = stashed.retentionScore || 0;
    state.gatePassed = stashed.gatePassed !== false;
    paintPost();
    show('post');
    if (!state.canPublish) {
      // They came back without granting it — say so plainly rather than letting
      // Publish silently reopen the same modal.
      showError('st-post-error', 'Publishing still needs permission. Press Publish to try again, or copy the post and paste it into LinkedIn.');
    }
    return;
  }

  show('ask');
  document.getElementById('st-answer')?.focus();
})();

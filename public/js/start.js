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

const SCREENS = ['signin', 'who', 'pick', 'ask', 'more', 'cook', 'post', 'earn'];

// The three ways in.
//
// Every one is a RECALL prompt, never an analysis prompt: it asks the author to
// remember something they already lived rather than to conclude something about
// their industry. That is the entire selection rule. Two earlier candidates were
// cut for failing it — "what's broken in your field" demands authority a new user
// doesn't feel entitled to claim, and "a mistake I made" demands a confession as
// your opening act in front of your professional network.
//
// postType MUST be a TYPE_SHAPES key from services/organizePost.js. It is passed
// through /api/generate straight into organizePost({ postType }), which resolves
// `TYPE_SHAPES[postType] || TYPE_SHAPES.reach` — so an unrecognised value does not
// error, it silently degrades to "a story or observation, whatever fits", the
// vaguest instruction in the table. 'announcement' is the live trap: it exists in
// POST_TYPE_DISPATCH but NOT in TYPE_SHAPES, so it reads as valid and fails quietly.
//
// The examples are deliberately unpolished. People mirror both the specificity and
// the REGISTER of what they are shown: a finished-looking sample makes someone try
// to write a finished post and freeze. These are what talking sounds like.
const TEMPLATES = [
  {
    id:       'conversation',
    postType: 'story',
    label:    'A conversation from this week',
    need:     'Something a client, colleague or prospect said that stuck with you.',
    question: 'Who were you talking to — and what did they say?',
    example:  "e.g. A prospect told me she'd been through three agencies before us. I asked what went wrong and she said none of them ever asked what we actually sell. That stopped me.",
  },
  {
    id:       'explain',
    postType: 'trust',
    label:    'The thing you explain over and over',
    need:     "Advice you've given more than once.",
    question: 'What do you keep having to explain — and what do people assume instead?',
    example:  "e.g. Everyone comes to me asking how to get more traffic. And I keep saying the same thing — traffic isn't the problem, nobody knows what to do when they land.",
  },
  {
    id:       'surprise',
    postType: 'lessons_learned',
    label:    'Something that surprised you',
    need:     'A recent result that went differently than you expected.',
    question: 'What did you expect would happen — and what actually happened?',
    example:  'e.g. I was sure the long onboarding call was why clients stuck around. Turns out the ones who stayed were the ones who replied to our first email.',
  },
];

// The escape hatch. Someone whose material fits none of the three must not be
// forced into a shape that mangles it — that is the one failure mode a fixed
// template set introduces, and it costs a single option to remove. 'auto' is not
// a TYPE_SHAPES key on purpose: the server reads it as "you decide" and runs
// pickPostShape over the author's words, which is exactly the old behaviour.
const OPEN_TEMPLATE = {
  id:       'open',
  postType: 'auto',
  label:    'Something else on my mind',
  need:     null,
  question: "What's on your mind?",
  example:  "e.g. Everyone wants to spend more on ads before they've checked whether anyone is actually calling their leads back.",
};

const state = {
  name: null,
  photo: null,
  headline: null,
  canPublish: false,
  expertise: '',
  audience: '',
  template: null,
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
  if (askH) askH.textContent = first ? `Got it, ${first}. Just one question.` : 'Just one question.';

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

// ── Who you are ─────────────────────────────────────────────────────────────

// Prefilled so a returning user isn't retyping what they already told us. Fired
// in parallel with the LinkedIn status call in boot(), so it costs no extra wait.
async function loadExistingProfile() {
  try {
    const r = await fetch('/api/profile', { credentials: 'same-origin' });
    const d = await r.json();
    const p = d?.profile;
    if (!p) return;
    state.expertise = p.brand_description   || '';
    state.audience  = p.audience_description || '';
    const exp = document.getElementById('st-expertise');
    const aud = document.getElementById('st-audience');
    if (exp && state.expertise) exp.value = state.expertise;
    if (aud && state.audience)  aud.value = state.audience;
  } catch (_) { /* prefill is a convenience — never block the flow on it */ }
}

// Fire-and-forget on purpose. These two lines make every future post better, but
// none of them is required to write THIS one, and a failed write must not strand
// someone two screens from their first post.
function saveProfile() {
  const payload = { expertise: state.expertise, audience: state.audience };
  try {
    fetch('/api/profile/starter', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch (_) { /* non-fatal */ }
}

// ── Pick a way in ───────────────────────────────────────────────────────────

function paintCards() {
  const wrap = document.getElementById('st-cards');
  if (!wrap || wrap.childElementCount) return;

  TEMPLATES.forEach((t) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'st-card';
    card.setAttribute('role', 'listitem');
    card.dataset.templateId = t.id;

    const label = document.createElement('span');
    label.className = 'st-card-label';
    label.textContent = t.label;

    const need = document.createElement('span');
    need.className = 'st-card-need';
    need.textContent = t.need;

    card.append(label, need);
    card.addEventListener('click', () => chooseTemplate(t));
    wrap.appendChild(card);
  });
}

function chooseTemplate(template) {
  state.template = template;
  paintAsk();
  show('ask');
  // Focus the textarea, not the mic: the mic needs a deliberate tap (it asks for
  // a permission), while a focused field lets someone who'd rather type start
  // immediately. The transcript still lands here either way.
  document.getElementById('st-answer')?.focus();
}

// Repaint the single question from the chosen template. Everything on the ask
// screen that names the topic comes from here, so the pinned chip, the heading,
// the placeholder and the hidden label can never drift apart.
function paintAsk() {
  const t = state.template || OPEN_TEMPLATE;

  const chip = document.getElementById('st-ask-chip');
  if (chip) {
    chip.textContent = t.label;
    chip.hidden = false;
  }

  const q = document.getElementById('st-ask-q');
  if (q) q.textContent = t.question;

  const answer = document.getElementById('st-answer');
  if (answer) {
    answer.placeholder = t.example;
    answer.setAttribute('aria-label', t.question);
  }

  const label = document.querySelector('label[for="st-answer"]');
  if (label) label.textContent = t.question;
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

  // Origin: the post card's own centre, not a fixed fraction of the viewport.
  // "30% down the screen" was measured on desktop, where the whole card fits
  // above the fold with room to spare. On a phone this screen's content (header
  // + title + a full post + rarity line + buttons + hint) runs well past one
  // viewport, so 30% down landed at the very top edge — on the card's author
  // row, not its middle — and clipped a chunk of the upward burst off-screen
  // before it was ever seen. Reading the card's real position fixes this at
  // every viewport size instead of guessing a percentage that only held for one.
  //
  // Clamped rather than trusted outright: if the card is taller than the
  // viewport or sits scrolled off-centre, its geometric centre can itself fall
  // outside the visible area, which would silently reintroduce the same bug.
  const cardEl = document.querySelector('.st-preview');
  const cardRect = cardEl?.getBoundingClientRect();
  const originX = cardRect ? cardRect.left + cardRect.width / 2 : w / 2;
  const rawOriginY = cardRect ? cardRect.top + cardRect.height / 2 : h * 0.3;
  const originY = Math.max(70, Math.min(h - 70, rawOriginY));

  // 120, not 180. Once the origin was corrected to the card's real centre, the
  // burst stopped being dispersed in empty space above the card and started
  // landing squarely on the post text and the quality badge. Fewer particles and
  // a wider initial spread thin the overlap without weakening the moment — the
  // celebration should frame the post, not cover it.
  const parts = [];
  for (let i = 0; i < 120; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 4 + Math.random() * 10;
    parts.push({
      x: originX + (Math.random() - 0.5) * 120,
      y: originY + (Math.random() - 0.5) * 40,
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
        // Required by /api/generate — it 400s with missing_path before it reads
        // anything else. 'idea' is the free-text entry point every other client
        // uses (public/js/generate.js), and it is what gets stored on the
        // generation_runs row. NOT the same "path" as the organize/write routing
        // decision described below, which the server makes for itself.
        path: 'idea',
        raw_idea: combinedAnswer(),
        // The tapped template's shape, not 'auto'. 'auto' makes the server run
        // pickPostShape over the author's words, and that heuristic tests
        // CONTRARIAN_CUE (everyone|most people|actually|isn't) BEFORE STORY_CUE —
        // so an answer that contains both a scene and the words "most people"
        // gets shaped as an assertion essay with the scene thrown away. The tap
        // is better information than any regex over their phrasing, so we use it.
        // Falls back to 'auto' for the escape hatch, which genuinely has no shape.
        post_type: (state.template || OPEN_TEMPLATE).postType,
        // Which way in they chose. Persisted on the post so the funnel
        // (template → generated → published) is readable per template.
        starter_template: (state.template || OPEN_TEMPLATE).id,
        source: 'start_flow',
        // No length_preference on purpose. The default is "match what they gave
        // you", which is the right rule for a spoken answer — a fixed 'short'
        // ceiling throws away material the author actually provided.
        // Retry once against the fidelity floor if the first pass composes rather
        // than organises. Only surfaces that claim "your words" turn this on.
        enforce_retention: true,
        // ALWAYS the editor, never the writer.
        //
        // This used to be left unset so the server's maturity router could pick,
        // and the router sends anything under 40 words to guided generation
        // (postEngine, temperature 0.8, "full authority over the hook, structure
        // and phrasing"). Two short spoken answers are routinely under 40 words,
        // so the flow that promises "your words" was handing most first posts to
        // the writer. Measured on 32 words of real input: the writer returned
        // ~130 words of fluent LinkedIn-guru prose in nobody's voice, and its
        // retention came back NULL — the writer path does not measure fidelity at
        // all, so retention_ok defaulted true and the safety net below could never
        // fire. The editor, on the identical input, returned the author's own
        // sentences at retention 0.77.
        //
        // The tradeoff is deliberate and is the point: thin material now yields a
        // SHORT post instead of a long invented one. When it is too thin to be a
        // post the quality gate says so and we ask for more, which is the only
        // thing that actually fixes thin material.
        generation_mode: 'organize',
        // Two answers to two questions we asked, concatenated — beats that were
        // written separately and were never meant to sit next to each other. This
        // grants the editor the one extra licence that needs: writing the bridges
        // between them. Without it the post reads as stacked fragments.
        brief_mode: !!state.followUp,
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
    // hook_was_written is the server's measurement of which rung the editor used
    // (never the model's self-report). Feeds the "Excellent" verdict tier below —
    // lifting the hook verbatim from the author is the strongest fidelity signal.
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

function paintPost() {
  const body = document.getElementById('st-preview-body');
  if (body) body.textContent = state.postText;
  paintVerdict();
  paintOwnership();
  paintRarity();
}

// "84% your words." The single cheapest thing on this screen, because the number
// was already being computed on every organize generation and discarded.
//
// It does two jobs at once: it is the recognition beat ("wait — I said that?"),
// and it is permission to publish, because the fear that stops a first post is
// not "is this good" but "is this me". Naming what we did to their sentences
// answers that in one line.
//
// Gated hard on the numbers being real. Shown only when the editor genuinely
// organised rather than composed (retention_ok) AND the share is high enough to
// claim ownership out loud. Below that, silence — a confident ownership claim on
// a post we largely wrote is the one lie this screen cannot afford, and it is the
// exact claim the reader can check by rereading their own answer.
const OWNERSHIP_MIN = 0.7;

function paintOwnership() {
  const el = document.getElementById('st-ownership');
  if (!el) return;

  const score = state.retentionScore;
  if (!state.retentionOk || typeof score !== 'number' || score < OWNERSHIP_MIN) {
    el.hidden = true;
    return;
  }

  const pct = Math.round(score * 100);
  const tail = state.hookLifted
    ? 'Even the opening line is yours — we just moved it to the top.'
    : 'We changed the order, not the words.';
  el.innerHTML =
    `<b>${pct}% your words.</b> ${tail}`;
  el.hidden = false;
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
// Two jobs in one line, not one: "less than 1%" answers "am I even the kind of
// person who does this?"; "rarely wait for perfect" answers the different fear
// of someone who's already decided to post and is stuck re-editing the third
// line. Deliberately third-person ("the ones who do") rather than addressing the
// reader directly — a claim about the reader ("you're about to...") has to stay
// in future tense to stay true before they've clicked, which this sidesteps by
// not making a claim about them at all. See the design doc for rejected drafts
// that used an em dash / direct address instead.
function paintRarity() {
  const el = document.getElementById('st-rarity');
  if (!el) return;
  const line = 'Less than 1% of people on LinkedIn ever hit post. The ones who do rarely wait for perfect.';
  // <mark> is the right element here — this is highlighted for relevance, not
  // emphasis — and it carries the highlighter styling in start.css.
  el.innerHTML = `<span class="st-rarity-icon" aria-hidden="true">🏆</span><mark>${line}</mark>`;
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

    // Published successfully — the post is live, so a stash left over from an
    // earlier permission round trip must not survive to hijack the next visit.
    clearStash();
    show('earn');
  } catch (_) {
    setLoading(btn, false);
    showError('st-post-error', 'We couldn’t publish that just now. Your post is saved in Drafts — you can publish it from there.');
  }
}

// Dismiss the permission dialog and go back to the post, which is still on the
// screen behind it — Publish reopens this, and Edit still leads to the editor.
//
// Clearing the stash is the whole reason this isn't a one-line hidden = true.
// publish() writes it before opening the dialog so the post survives the round
// trip to LinkedIn; dismissing means there is no round trip, so the stash would
// sit in sessionStorage and hijack the next /start visit in this tab — boot()
// would restore this post instead of the question, with no way back to a blank
// screen short of closing the tab.
function closeModal() {
  clearStash();
  document.getElementById('st-modal').hidden = true;
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

// Below RAW_MIN_WORDS there isn't enough material to build a post out of, so ask
// instead of generating. Measured: 12 words in, and the editor faithfully returns
// the same idea three times because that is all it was given, while the quality
// gate passes it at 100 (the gate is an integrity check, not a grade).
//
// The threshold no longer picks an ENGINE — /start always uses the editor — but
// it is still the right place to ask, and it is still the same number, because
// "enough material to organise" is the question in both cases. Asking one more
// question is the only thing that fixes thin material; a retry has no more to
// work with than the first attempt did.
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
  document.getElementById('st-who-go')?.addEventListener('click', () => {
    const expertise = document.getElementById('st-expertise')?.value.trim() || '';
    const audience  = document.getElementById('st-audience')?.value.trim()  || '';

    // Both required. This is the only place these two fields are ever collected
    // for most users, and a blank one silently degrades every post they generate
    // from here on — worth one line of friction to avoid.
    if (expertise.length < 3 || audience.length < 2) {
      showError('st-who-error', 'Both lines, even roughly — they shape every post we write for you.');
      return;
    }

    state.expertise = expertise;
    state.audience  = audience;
    clearError('st-who-error');
    saveProfile();
    paintCards();
    show('pick');
  });

  document.getElementById('st-pick-open')?.addEventListener('click', () => {
    chooseTemplate(OPEN_TEMPLATE);
  });

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

  document.getElementById('st-edit')?.addEventListener('click', () => {
    // /editor/<id>, NOT /editor.html?postId=<id>. The editor takes its id from the
    // URL PATH (editor.html: pathname.split('/').pop()), served by the
    // app.get('/editor/:postId') route. Given the query-param form, pathname is
    // "/editor.html", so the id resolved to the literal string "editor.html" and
    // the editor fetched /api/generate/post/editor.html — hence "Failed to load
    // post" on a post that had generated and saved perfectly well.
    window.location.href = state.postId ? `/editor/${encodeURIComponent(state.postId)}` : '/drafts.html';
  });

  document.getElementById('st-publish')?.addEventListener('click', publish);

  // Three ways out, because a dialog with one action and no exit is a trap:
  // the × , the backdrop, and Escape. The backdrop check is on currentTarget so
  // a click inside the card doesn't bubble up and close it.
  document.getElementById('st-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('st-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('st-modal')?.hidden) closeModal();
  });

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

  // Both in parallel, both behind the same loader: the profile prefill only feeds
  // the two fields on the first screen, so paying for it serially would show an
  // empty form and then populate it, or leave a blank beat after the loader hides.
  const [connected] = await Promise.all([loadLinkedInStatus(), loadExistingProfile()]);
  document.getElementById('st-init').style.display = 'none';

  // Read the stash BEFORE branching on oauthError. Denying the *write-scope*
  // upgrade also comes back with linkedin_error set, but that user is already
  // signed in and has a finished post waiting — bouncing them to the sign-in
  // screen would be wrong twice over (they're signed in, and their post would
  // be stranded in the stash for the next visit to resurrect).
  const stashed = readStash();

  // A genuine sign-in failure: errored AND no usable connection.
  if (oauthError && !connected) {
    clearStash();
    show('signin');
    showError('st-signin-error', 'That didn’t go through. Try connecting again — nothing was shared.');
    return;
  }

  if (!connected) {
    clearStash();
    show('signin');
    return;
  }

  paintIdentity();

  // Returning from the write-scope grant with the post we generated before the
  // redirect: put them back on it, ready to publish, instead of a blank question
  // they've already answered.
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
      // Came back without granting it — whether they declined on LinkedIn or hit
      // an error, the recovery is identical, so say it plainly rather than
      // letting Publish silently reopen the same modal.
      showError('st-post-error', 'Publishing still needs permission. Press Publish to try again, or copy the post and paste it into LinkedIn.');
    }
    return;
  }

  // Fresh run: who → pick → ask. A returning user finds their own answers already
  // in the two fields (prefilled above) and can pass straight through.
  show('who');
  document.getElementById('st-expertise')?.focus();
})();

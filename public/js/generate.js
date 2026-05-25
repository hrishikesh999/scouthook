/* generate.js — guided chat redesign */

/* ── Helpers ─────────────────────────────────────────────────── */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── State ───────────────────────────────────────────────────── */
let selectedType        = null; // 'reach'|'trust'|'convert'|'lead_magnet'
let chatStep            = 0;
let chatAnswers         = {};
let mixRecommended      = null;
let selectedVaultIdeaId = null; // set when user picks a vault idea
let _tensionResult      = null; // { tension, missing } from silent extraction
let _tensionDebounce    = null; // debounce timer for extraction on input

/* ── DOM refs ────────────────────────────────────────────────── */
const guidedChat          = document.getElementById('guided-chat');
const intentBtns          = document.querySelectorAll('.intent-btn');
const chatThread          = document.getElementById('chat-thread');
const chatInput           = document.getElementById('chat-input');
const chatSendBtn         = document.getElementById('chat-send-btn');
const chatError           = document.getElementById('chat-error');
const chatSubstanceWarn   = document.getElementById('chat-substance-warning');
const chatSubstanceText   = document.getElementById('chat-substance-text');
const chatGenerateAnyway  = document.getElementById('chat-generate-anyway');
const processingScreen    = document.getElementById('processing-screen');
const specificityNudge    = document.getElementById('specificity-nudge');
let _nudgeDebounce        = null;

/* ── Per-type chat configs ───────────────────────────────────── */
const CHAT_CONFIGS = {
  reach: {
    label:     '📣 Reach post',
    chatTitle: 'You are creating a Reach post',
    chatDesc:  'Reach posts grow your audience. Share a story, contradiction, or moment that makes a stranger stop scrolling and feel understood.',
    steps: [{
      question:    "What's the story, moment, or observation you want to build from?",
      placeholder: "A lesson learned, a result you got, something that surprised you…",
      multiline:   true,
    }],
  },
  trust: {
    label:     '🎯 Authority post',
    chatTitle: 'You are creating an Authority post',
    chatDesc:  'Authority posts build your reputation as an expert. Lead with a non-obvious insight, a contrarian view, or a framework only you could have written.',
    steps: [{
      question:    "What's the insight, opinion, or expertise you want to lead with?",
      placeholder: "A contrarian view, a framework you use, a mistake you see others making…",
      multiline:   true,
    }],
  },
  convert: {
    label:     '💬 Conversation post',
    chatTitle: 'You are creating a Conversation post',
    chatDesc:  'Conversation posts drive immediate action. Anchor the post in a real result or client win, then make a direct ask that moves readers toward a reply or DM.',
    steps: [{
      question:    "What result, outcome, or proof point should this post anchor in?",
      placeholder: "A client win, a specific result, a before/after…",
      multiline:   true,
    }],
  },
  lead_magnet: {
    label:     '🎁 Lead magnet',
    chatTitle: 'You are creating a Lead Magnet post',
    chatDesc:  'Lead magnet posts build your DM pipeline. Give away something genuinely useful, ask readers to comment a keyword, and deliver it in their inbox.',
    steps: [
      {
        question:    "What are you giving away?",
        placeholder: "e.g. LinkedIn Hook Swipe File",
        multiline:   false,
      },
      {
        question:    "What's inside?\nOne deliverable per line — specific beats vague.",
        placeholder: "e.g.\n50 fill-in-the-blank hook templates\nOrganised by trigger: curiosity, fear, desire\nReal viral examples showing how each works",
        multiline:   true,
      },
      {
        question:    "What's your proof? Real numbers only — we won't invent these.\n\ne.g. \"Helped 3 clients go from 500 to 8K followers in 90 days\"\ne.g. \"Used by 40+ consultants to cut proposal time in half\"",
        placeholder: "Your specific result or proof…",
        multiline:   true,
        hasEscape:   true,
      },
      {
        question:    "Last one — what word should people comment to receive this?",
        placeholder: "e.g. HOOKS or PLAYBOOK",
        multiline:   false,
      },
    ],
  },
};

/* ── Extraction questions (reach / trust / convert) ──────────── */
const EXTRACTION_QUESTIONS = {
  reach: [
    {
      key:         'moment',
      label:       '1 of 3',
      question:    "What's a specific moment or result that surprised you?",
      placeholder: "e.g. I sent a one-line proposal with no deck. They signed the same day — every other agency had sent 40 slides.",
      required:    true,
      minChars:    60,
      errorMsg:    'Give us the moment — what specifically happened?',
      example:     'Moments that tend to work well:\n\n"Sent a one-line proposal with no deck. Client signed the same day — every other agency had sent 40 slides."\n\n"Posted for the first time in 8 months. That one post generated more inbound in 48 hours than the previous year combined."\n\n"Turned down a promotion. Three months later, got an offer at double the salary from a competitor."\n\nSpecific + surprising = good material. The AI finds the tension.',
    },
    {
      key:         'lesson',
      label:       '2 of 3',
      question:    'What would you tell someone in the same situation to do?',
      placeholder: 'e.g. Stop preparing for the client you think you have. Prepare for the one who already decided.',
      required:    false,
      nudge:       'Adding this gives readers something to save — the utility layer that earns reach on day 2 and 3.',
    },
    {
      key:         'angle',
      label:       '3 of 3',
      question:    'What would most people in your position have done differently here?',
      placeholder: 'e.g. Sent a more detailed deck. Offered a call. I just sent one number and one sentence.',
      required:    false,
      nudge:       "This is what earns comments — the thing that makes readers say \"I've never thought of it that way.\"",
    },
  ],
  trust: [
    {
      key:         'contrarian',
      label:       '1 of 3',
      question:    'What does everyone in your field believe that your experience has shown to be wrong — or at least incomplete?',
      placeholder: "e.g. Everyone says hire slow, fire fast. In practice I've found the opposite — the hiring decision is rarely the real problem.",
      required:    true,
      minChars:    60,
      errorMsg:    'State your position directly — a belief you hold that contradicts the conventional view.',
    },
    {
      key:         'proof',
      label:       '2 of 3',
      question:    'What specific moment or result convinced you of this? Numbers if you have them.',
      placeholder: 'e.g. A client doubled close rate in 8 weeks by firing their bottom 20% of prospects. No one acted on that advice before seeing proof.',
      required:    false,
      nudge:       'The evidence is what turns an opinion into a post people save and share.',
    },
    {
      key:         'audience',
      label:       '3 of 3',
      question:    'Who needs to hear this most? Describe the exact person.',
      placeholder: 'e.g. A founder at $2–5M ARR who keeps saying yes to any client that shows up.',
      required:    false,
      nudge:       'Naming the person makes the post feel written for them — that\'s what drives comments.',
    },
  ],
  convert: [
    {
      key:         'result',
      label:       '1 of 3',
      question:    'What was the situation before, what specifically changed, and what was the measurable result?',
      placeholder: 'e.g. Before: $18k/month, cold outreach, 90-min calls on small projects. Change: repositioned and rewrote outreach. After: $61k/month in 14 weeks, inbound only.',
      required:    true,
      minChars:    60,
      errorMsg:    'Give us the before, the change, and the result — with numbers if you have them.',
    },
    {
      key:         'mechanism',
      label:       '2 of 3',
      question:    'What was the single most important decision or change that drove the result?',
      placeholder: 'e.g. Stopping all cold outreach the same week we rewrote the positioning. The constraint forced the change.',
      required:    false,
      nudge:       'The mechanism is what makes readers think "I could do that" — it\'s what drives the DM.',
    },
    {
      key:         'target',
      label:       '3 of 3',
      question:    'Who should DM you after reading this? Describe them in one sentence.',
      placeholder: 'e.g. A freelancer or agency owner billing under $100k/year who knows their work is better than their results suggest.',
      required:    false,
      nudge:       'Naming who the post is for is what makes the right person reach out.',
    },
  ],
};


/* ── Type selection ──────────────────────────────────────────── */
intentBtns.forEach(btn => btn.addEventListener('click', () => selectType(btn.dataset.type)));

function selectType(type) {
  selectedType        = type;
  chatStep            = 0;
  chatAnswers         = {};
  selectedVaultIdeaId = null;
  _tensionResult      = null;
  clearTimeout(_tensionDebounce);

  intentBtns.forEach(b => b.classList.toggle('active', b.dataset.type === type));
  hideChatError();
  hideSubstanceWarning();
  hideSpecificityNudge();

  chat.init(type);
}

/* ── Mix recommendation ──────────────────────────────────────── */
async function loadMixRecommendation() {
  try {
    const res  = await fetch('/api/posts/mix-recommendation', { headers: apiHeaders() });
    const data = await res.json();
    if (!data.ok) return;

    mixRecommended = data.recommended_type || null;

    if (data.has_enough_data && data.nudge && mixRecommended) {
      const nudgeEl    = document.getElementById('mix-nudge');
      const questionEl = document.getElementById('gen-question');
      if (nudgeEl)    { nudgeEl.textContent = '✦ ' + data.nudge; nudgeEl.style.display = ''; }
      if (questionEl)   questionEl.textContent = 'Time to mix it up?';
    }

    markRecommendedBtn();
    if (mixRecommended && mixRecommended !== selectedType && !chatInput.value.trim()) {
      selectType(mixRecommended);
    }
  } catch { /* non-fatal */ }
}

function markRecommendedBtn() {
  intentBtns.forEach(btn => {
    btn.classList.toggle('recommended', btn.dataset.type === mixRecommended);
  });
}

/* ── Vault panel ─────────────────────────────────────────────── */
async function loadVaultPanel(type) {
  const panel = document.getElementById('vault-panel');
  if (!panel) return;
  panel.style.display = 'none';
  panel.innerHTML = '';
  try {
    const res  = await fetch(`/api/vault/ideas?status=fresh&funnel_type=${type}`, { headers: apiHeaders() });
    const data = await res.json();
    const ideas = (data.ideas || []).slice(0, 3);
    if (ideas.length) {
      renderVaultPanel(panel,
        ideas.map(i => ({ text: i.seed_text, label: i.hook_preview || i.seed_text.slice(0, 80), id: i.id })),
        'From your vault:');
      return;
    }
    const sugRes  = await fetch(`/api/vault/suggest-topics?post_type=${type}`, { headers: apiHeaders() });
    const sugData = await sugRes.json();
    const topics  = (sugData.topics || []).slice(0, 3);
    if (topics.length) {
      renderVaultPanel(panel,
        topics.map(t => ({ text: t.textarea_input || t.description || t.title, label: t.title, id: null })),
        'Need a starting point?');
    }
  } catch { /* non-fatal */ }
}

function renderVaultPanel(panel, items, title) {
  panel.innerHTML =
    `<div class="vault-panel-header"><span class="vault-panel-title">${escapeHtml(title)}</span></div>` +
    `<div class="vault-panel-items">${items.map((item, i) =>
      `<button class="vault-panel-item" type="button" data-idx="${i}">${escapeHtml(item.label)}</button>`
    ).join('')}</div>`;
  panel.querySelectorAll('.vault-panel-item').forEach((btn, i) => {
    btn.addEventListener('click', async () => {
      selectedVaultIdeaId = items[i].id;

      // Fill immediately with seed_text for instant feedback
      chatInput.value        = items[i].text;
      chatInput.style.height = 'auto';
      chatInput.style.height = chatInput.scrollHeight + 'px';
      chatInput.classList.remove('error');
      hideChatError();
      chatInput.focus();
      if (items[i].text.length >= 30) chat.fireTensionExtraction(items[i].text);

      // Vault ideas: enrich from the source chunk in the background
      if (items[i].id && selectedType && selectedType !== 'lead_magnet') {
        const seedVal = items[i].text;
        showSpecificityNudge('Pulling specifics from your vault…');
        try {
          const r = await fetch(
            `/api/vault/expand-idea?id=${encodeURIComponent(items[i].id)}&post_type=${encodeURIComponent(selectedType)}`,
            { headers: apiHeaders() }
          );
          const d = await r.json();
          // Only replace if user hasn't started editing
          if (d.ok && d.expanded_input && chatInput.value === seedVal) {
            chatInput.value        = d.expanded_input;
            chatInput.style.height = 'auto';
            chatInput.style.height = chatInput.scrollHeight + 'px';
            chat.fireTensionExtraction(d.expanded_input);
          }
        } catch { /* non-fatal — keep seed_text */ }
        hideSpecificityNudge();
        checkSpecificityNudge(chatInput.value.trim());
      }
    });
  });
  panel.style.display = '';
}

/* ── Chat module ─────────────────────────────────────────────── */
const chat = (() => {
  let _type        = null;
  let _lmProofMode = 'metric'; // 'metric' | 'description' for LM step 2

  function addBot(text, opts = {}) {
    const div = document.createElement('div');
    div.className = 'chat-bubble-bot';

    const mainEl = document.createElement('div');
    mainEl.className = 'chat-bubble-main';
    mainEl.textContent = text;
    div.appendChild(mainEl);

    if (opts.hasEscape) {
      const btn = document.createElement('button');
      btn.style.cssText = 'display:block;margin-top:10px;font-size:0.8125rem;color:var(--brand);' +
        'font-weight:500;background:none;border:none;padding:0;cursor:pointer;' +
        'text-decoration:underline;font-family:var(--font-sans);text-align:left;';
      btn.textContent = 'No metric yet? Describe who it worked for →';
      btn.addEventListener('click', () => {
        _lmProofMode       = 'description';
        mainEl.textContent = 'Who has this worked for? Describe the person or situation.';
        chatInput.placeholder = 'e.g. "SaaS founders who want to grow their LinkedIn without paid ads"';
        chatInput.value    = '';
        chatInput.focus();
        hideChatError();
      });
      div.appendChild(btn);
    }

    chatThread.appendChild(div);
    chatThread.scrollTop = chatThread.scrollHeight;
    return div;
  }

  function addUser(text) {
    const div = document.createElement('div');
    div.className = 'chat-bubble-user';
    div.textContent = text;
    chatThread.appendChild(div);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function setInputState(cfg) {
    chatInput.placeholder     = cfg.placeholder || '';
    const multiline           = cfg.multiline !== false;
    chatInput.rows            = multiline ? 4 : 1;
    chatInput.style.minHeight = multiline ? '100px' : '44px';
    chatInput.value           = '';
    chatInput.style.height    = '';
    chatInput.classList.remove('error');
  }

  function updateSendBtn() {
    if (_type === 'lead_magnet') {
      const isLast = chatStep >= CHAT_CONFIGS.lead_magnet.steps.length - 1;
      chatSendBtn.textContent = isLast ? 'Write my lead magnet →' : 'Next →';
    } else {
      chatSendBtn.textContent = 'Generate →';
    }
  }

  function fireTensionExtraction(answer) {
    _tensionResult = null;
    fetch('/api/generate/extract-tension', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify({ post_type: _type, answer }),
    })
      .then(r => r.json())
      .then(d => { _tensionResult = d.ok ? { tension: d.tension, missing: d.missing } : { tension: null, missing: null }; })
      .catch(() => { _tensionResult = { tension: null, missing: null }; });
  }

  function init(type) {
    const prevType   = _type;
    _type            = type;
    _lmProofMode     = 'metric';
    _tensionResult   = null;
    selectedVaultIdeaId = null;

    chatThread.innerHTML = '';
    const vaultPanel = document.getElementById('vault-panel');

    if (type === 'lead_magnet') {
      if (vaultPanel) { vaultPanel.style.display = 'none'; vaultPanel.innerHTML = ''; }
      chatThread.style.display = '';
      const step0 = CHAT_CONFIGS.lead_magnet.steps[0];
      addBot(step0.question, { hasEscape: step0.hasEscape });
      setInputState(step0);  // clears input — structured flow needs a clean start
    } else {
      chatThread.style.display = 'none';
      const q0 = EXTRACTION_QUESTIONS[type][0];
      chatInput.placeholder = q0.placeholder;
      chatInput.rows        = 4;
      chatInput.style.minHeight = '100px';
      chatInput.classList.remove('error');

      // Preserve input when switching between reach/trust/convert.
      // Clear only when coming from lead_magnet (where the value belongs to its flow).
      if (!prevType || prevType === 'lead_magnet') {
        chatInput.value      = '';
        chatInput.style.height = '';
      } else {
        chatInput.style.height = 'auto';
        chatInput.style.height = chatInput.scrollHeight + 'px';
      }

      loadVaultPanel(type);
    }
    updateSendBtn();
    chatInput.focus();
  }

  function advance() {
    hideChatError();
    hideSubstanceWarning();

    const val = chatInput.value.trim();

    // ── Lead magnet path (unchanged) ────────────────────────────
    if (_type === 'lead_magnet') {
      const cfg = CHAT_CONFIGS.lead_magnet;

      if (!val) {
        showChatInputError('Add something before continuing.');
        chatInput.focus();
        return;
      }
      if (chatStep === 1) {
        const lines = val.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 3) {
          showChatInputError("Add at least 3 specific items — readers decide whether to comment based on what's inside.");
          chatInput.focus();
          return;
        }
      }
      if (chatStep === 3 && val.includes(' ')) {
        showChatInputError('The keyword must be a single word — no spaces.');
        chatInput.focus();
        return;
      }

      addUser(val);
      if (chatStep === 0)      chatAnswers.resourceName = val;
      else if (chatStep === 1) chatAnswers.deliverables = val.split('\n').map(l => l.trim()).filter(Boolean);
      else if (chatStep === 2) { chatAnswers.proof = val; chatAnswers.proofMode = _lmProofMode; }
      else if (chatStep === 3) chatAnswers.keyword = val.toUpperCase();
      chatStep++;

      if (chatStep < cfg.steps.length) {
        const nextStep = cfg.steps[chatStep];
        setTimeout(() => {
          addBot(nextStep.question, { hasEscape: nextStep.hasEscape });
          setInputState(nextStep);
          updateSendBtn();
          chatInput.focus();
        }, 300);
      } else {
        triggerLeadMagnetGenerate();
      }
      return;
    }

    // ── Extraction path: single input → generate directly ───────
    if (!val) {
      showChatInputError('Add something before generating.');
      chatInput.focus();
      return;
    }
    if (val.length < 30) {
      showChatInputError('Add a bit more — the more specific, the better the post.');
      chatInput.focus();
      return;
    }
    if (!_tensionResult && val.length >= 30) fireTensionExtraction(val);
    triggerGenerate({});
  }

  return { init, advance, fireTensionExtraction };
})();

/* ── Chat input wiring ───────────────────────────────────────── */
chatSendBtn.addEventListener('click', () => chat.advance());

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = chatInput.scrollHeight + 'px';
  chatInput.classList.remove('error');
  hideChatError();
  hideSubstanceWarning();

  const val = chatInput.value.trim();

  // Debounced silent tension extraction for reach/trust/convert
  if (selectedType && selectedType !== 'lead_magnet') {
    clearTimeout(_tensionDebounce);
    _tensionResult = null;
    if (val.length >= 40) {
      _tensionDebounce = setTimeout(() => chat.fireTensionExtraction(val), 600);
    }
  }

  // Debounced specificity nudge
  clearTimeout(_nudgeDebounce);
  specificityNudge.classList.remove('visible');
  _nudgeDebounce = setTimeout(() => checkSpecificityNudge(val), 1200);
});

chatInput.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (selectedType && selectedType !== 'lead_magnet') {
    // Extraction path: always multiline — only Cmd/Ctrl+Enter submits
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); chat.advance(); }
    return;
  }
  const step = CHAT_CONFIGS.lead_magnet?.steps[chatStep];
  if (!step?.multiline || e.metaKey || e.ctrlKey) {
    e.preventDefault();
    chat.advance();
  }
});

/* ── Generate ────────────────────────────────────────────────── */
chatGenerateAnyway.addEventListener('click', () => {
  triggerGenerate({ skipSubstanceCheck: true });
});

async function triggerGenerate(opts = {}) {
  hideChatError();
  hideSubstanceWarning();

  const isExtraction = selectedType && selectedType !== 'lead_magnet';
  const idea         = isExtraction ? chatInput.value.trim() : (chatAnswers.step0 || '');
  const tensionStmt  = opts.tensionStatement !== undefined
    ? opts.tensionStatement
    : (_tensionResult?.tension || null);

  hideSpecificityNudge();
  showProcessingScreen(idea, selectedType);

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 90_000);

  try {
    const body = { path: 'idea', raw_idea: idea, post_type: selectedType || null };
    if (tensionStmt)             body.tension_statement    = tensionStmt;
    if (opts.skipSubstanceCheck) body.skip_substance_check = true;
    if (selectedVaultIdeaId)     body.vault_idea_id         = selectedVaultIdeaId;

    const res  = await fetch('/api/generate', {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify(body), signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json();

    if (!res.ok || !data.ok) {
      const err = new Error(data.error || 'generation_failed');
      if (data.error === 'plan_limit_exceeded') { err.planCurrent = data.current; err.planLimit = data.limit; }
      if (data.error === 'missing_substance')   err.substancePrompt = data.prompt;
      throw err;
    }

    finaliseProcessingSteps(data);
    await sleep(600);
    window.location.href = `/editor/${encodeURIComponent(data.id)}`;

  } catch (err) {
    clearTimeout(timeoutId);
    hideProcessingScreen();

    if (err.name === 'AbortError') {
      showChatError('This is taking longer than expected. <a href="#">Try again →</a>');
    } else if (err.message === 'missing_substance') {
      showSubstanceWarning(err.substancePrompt || 'Add a specific outcome or contrarian view to improve this post.');
    } else if (err.message === 'complete_profile_first') {
      showChatError('Your voice profile is incomplete — posts need it to generate. <a href="/settings.html">Complete it →</a>');
    } else if (err.message === 'plan_limit_exceeded') {
      const used = (err.planCurrent != null && err.planLimit != null)
        ? ` You've used ${err.planCurrent} of ${err.planLimit} this month.` : '';
      showChatError(`You've reached the free plan limit.${used} <a href="/billing.html" class="js-upgrade-cta">Upgrade to Pro →</a>`);
    } else if (err.message === 'rate_limit_exceeded') {
      showChatError("You've hit the hourly generation limit. Wait a few minutes and try again.");
    } else if (err.message === 'high_demand') {
      showChatError('ScoutHook is under high demand right now. Wait 30 seconds and try again.');
    } else {
      showChatError('Something went wrong. <a href="#">Try again →</a>');
    }
  }
}

/* ── Lead magnet generation ──────────────────────────────────── */
async function triggerLeadMagnetGenerate() {
  hideChatError();
  hideSubstanceWarning();
  showProcessingScreen(chatAnswers.resourceName || '', 'lead_magnet');

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 90_000);

  try {
    const res = await fetch('/api/generate', {
      method:  'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        path:      'idea',
        post_type: 'lead_magnet',
        lead_magnet_inputs: {
          resourceName: chatAnswers.resourceName,
          deliverables: chatAnswers.deliverables,
          proof:        chatAnswers.proof,
          keyword:      chatAnswers.keyword,
          proofMode:    chatAnswers.proofMode || 'metric',
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'generation_failed');

    finaliseProcessingSteps(data);
    await sleep(600);
    window.location.href = `/editor/${encodeURIComponent(data.id)}`;

  } catch (err) {
    clearTimeout(timeoutId);
    hideProcessingScreen();

    const msg = err.name === 'AbortError'          ? 'This is taking too long. Please try again.'
      : err.message === 'plan_limit_exceeded'      ? 'You\'ve reached the generation limit. <a href="/billing.html">Upgrade →</a>'
      : err.message === 'missing_keyword'          ? 'Keyword missing from generated post. Try regenerating.'
      : 'Something went wrong. Please try again.';
    showChatError(msg);
  }
}

/* ── Processing screen ───────────────────────────────────────── */
function extractAngleLabel(rawIdea) {
  const FILLER = /^(so|well|i|we|the|a|an|its|it|this|that|here|just|actually|basically)\b\s*/gi;
  const cleaned  = rawIdea.replace(/\n.*/s, '').trim();
  const stripped = cleaned.replace(FILLER, '').trim();
  const snippet  = stripped.replace(/[,;:!?].*/, '').slice(0, 40).trim();
  return snippet || 'your idea';
}

function showProcessingScreen(rawIdea, postType) {
  guidedChat.classList.add('hidden');
  processingScreen.classList.add('visible');

  const steps = [
    'Analysing your idea…',
    `Found the angle: ${extractAngleLabel(rawIdea || '')}`,
    'Selecting the hook type…',
    'Final quality check…',
  ];

  for (let i = 0; i < 4; i++) {
    const el = document.getElementById(`proc-step-${i}`);
    if (!el) continue;
    el.className = 'proc-step';
    el.querySelector('.proc-step-icon').innerHTML = '⏳';
    el.querySelector('.proc-step-text').textContent = steps[i];
  }

  let delay = 0;
  for (let i = 0; i < 4; i++) {
    const d = delay;
    setTimeout(() => {
      const el = document.getElementById(`proc-step-${i}`);
      if (!el) return;
      el.classList.add('visible');
      if (i < 3) {
        el.classList.add('done');
        el.querySelector('.proc-step-icon').innerHTML = '✅';
      } else {
        el.querySelector('.proc-step-icon').innerHTML = '<span class="proc-spinner"></span>';
      }
    }, d);
    delay += 800;
  }
}

function finaliseProcessingSteps(data) {
  const archetype = data.archetypeUsed || data.archetype_used;
  const step2 = document.getElementById('proc-step-2');
  if (step2) {
    step2.querySelector('.proc-step-text').textContent = archetype ? `Hook type: ${archetype}` : 'Selecting template structure…';
    step2.querySelector('.proc-step-icon').innerHTML = '✅';
    step2.classList.add('done');
  }
  const step3 = document.getElementById('proc-step-3');
  if (step3) {
    step3.querySelector('.proc-step-icon').innerHTML = '✅';
    step3.querySelector('.proc-step-text').textContent = 'Ready.';
    step3.classList.add('done', 'visible');
  }
}

function hideProcessingScreen() {
  processingScreen.classList.remove('visible');
  guidedChat.classList.remove('hidden');
  // Re-evaluate nudge state when user returns to edit after an error
  checkSpecificityNudge(chatInput.value.trim());
}

/* ── Specificity nudge ───────────────────────────────────────── */
function checkSpecificityNudge(val) {
  if (!val || !selectedType || selectedType === 'lead_magnet') { hideSpecificityNudge(); return; }
  const hasNumbers = /\d/.test(val);
  if (val.length < 30) { hideSpecificityNudge(); return; }
  if (val.length < 80 && !hasNumbers) {
    showSpecificityNudge('Add a specific result, number, or decision — generic inputs produce generic posts.');
  } else if (val.length >= 80 && !hasNumbers) {
    showSpecificityNudge('No numbers yet — a percentage, revenue figure, or timeframe makes this far more memorable.');
  } else {
    hideSpecificityNudge();
  }
}
function showSpecificityNudge(msg) {
  specificityNudge.textContent = '↑ ' + msg;
  specificityNudge.classList.add('visible');
}
function hideSpecificityNudge() {
  specificityNudge.classList.remove('visible');
  clearTimeout(_nudgeDebounce);
}

/* ── Error helpers ───────────────────────────────────────────── */
function showChatError(html) {
  chatError.innerHTML = html;
  chatError.classList.add('visible');
  chatError.querySelector('a[href="#"]')?.addEventListener('click', e => { e.preventDefault(); triggerGenerate(); });
  chatError.querySelector('a.js-upgrade-cta')?.addEventListener('click', e => {
    if (window.PricingModal) { e.preventDefault(); window.PricingModal.open(); }
  });
}
function hideChatError() {
  chatError.classList.remove('visible');
  chatInput.classList.remove('error');
}
function showChatInputError(msg) {
  chatInput.classList.add('error');
  showChatError(msg);
}
function showSubstanceWarning(msg) {
  chatSubstanceText.textContent = msg;
  chatSubstanceWarn.classList.add('visible');
}
function hideSubstanceWarning() {
  chatSubstanceWarn.classList.remove('visible');
}

/* ── Profile gate ────────────────────────────────────────────── */
async function checkProfileGate() {
  try {
    const res  = await fetch('/api/profile', { headers: apiHeaders() });
    const data = await res.json();
    if (!data.ok) return;
    const profile = data.profile || {};
    if (!profile.content_niche?.trim()) showProfileNudge();
  } catch { /* gate fails open */ }
}

function showProfileNudge() {
  if (document.getElementById('profile-gate-nudge')) return;
  const nudge = document.createElement('div');
  nudge.id        = 'profile-gate-nudge';
  nudge.className = 'profile-gate-nudge';
  nudge.innerHTML = '<strong>Your voice profile is empty.</strong> Posts will be generic until you tell ScoutHook your niche and audience. <a href="/settings.html#voice">Set it up now →</a>';
  guidedChat.insertAdjacentElement('beforebegin', nudge);
}

/* ── Init ────────────────────────────────────────────────────── */
(async function init() {
  await window.scouthookAuthReady;

  // Default to reach immediately; loadMixRecommendation may update this
  selectType('reach');

  loadMixRecommendation(); // fire-and-forget — updates active btn if mix recommends a type
  checkProfileGate();      // fire-and-forget — nudge appears if profile is empty

  const urlParams = new URLSearchParams(location.search);
  const urlType   = urlParams.get('type');
  const urlIdea   = urlParams.get('idea');

  if (urlType && CHAT_CONFIGS[urlType]) {
    selectType(urlType);
    if (urlIdea) {
      chatInput.value        = urlIdea;
      chatInput.style.height = 'auto';
      chatInput.style.height = chatInput.scrollHeight + 'px';
    }
  } else if (urlIdea) {
    chatInput.value        = urlIdea;
    chatInput.style.height = 'auto';
    chatInput.style.height = chatInput.scrollHeight + 'px';
  }
})();

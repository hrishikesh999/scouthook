/* generate.js — guided chat redesign */

/* ── Helpers ─────────────────────────────────────────────────── */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── State ───────────────────────────────────────────────────── */
let selectedType   = null; // 'reach'|'trust'|'convert'|'lead_magnet'
let chatStep       = 0;
let chatAnswers    = {};
let mixRecommended = null;

/* ── DOM refs ────────────────────────────────────────────────── */
const typeSelectorSection = document.getElementById('type-selector-section');
const typeChips           = document.querySelectorAll('.type-chip');
const guidedChat          = document.getElementById('guided-chat');
const chatTypeLabel       = document.getElementById('chat-type-label');
const chatChangeBtn       = document.getElementById('chat-change-btn');
const chatThread          = document.getElementById('chat-thread');
const chatInput           = document.getElementById('chat-input');
const chatSendBtn         = document.getElementById('chat-send-btn');
const chatError           = document.getElementById('chat-error');
const chatSubstanceWarn   = document.getElementById('chat-substance-warning');
const chatSubstanceText   = document.getElementById('chat-substance-text');
const chatGenerateAnyway  = document.getElementById('chat-generate-anyway');
const attachBtn           = document.getElementById('attach-btn');
const attachFileInput     = document.getElementById('attach-file-input');
const processingScreen    = document.getElementById('processing-screen');

/* ── Per-type chat configs ───────────────────────────────────── */
const CHAT_CONFIGS = {
  reach: {
    label: '📣 Reach post',
    steps: [{
      question:    "What's the story, moment, or observation you want to build from?",
      placeholder: "A lesson learned, a result you got, something that surprised you…",
      multiline:   true,
    }],
  },
  trust: {
    label: '🎯 Authority post',
    steps: [{
      question:    "What's the insight, opinion, or expertise you want to lead with?",
      placeholder: "A contrarian view, a framework you use, a mistake you see others making…",
      multiline:   true,
    }],
  },
  convert: {
    label: '💬 Conversation post',
    steps: [{
      question:    "What result, outcome, or proof point should this post anchor in?",
      placeholder: "A client win, a specific result, a before/after…",
      multiline:   true,
    }],
  },
  lead_magnet: {
    label: '🎁 Lead magnet',
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

/* ── Suggestion chip sources ─────────────────────────────────── */
const FALLBACK_CHIPS = {
  reach: [
    "A mistake I made that taught me something",
    "A result that surprised me",
    "Something I believed, then changed my mind about",
  ],
  trust: [
    "A common misconception in my field",
    "The framework I use that others don't",
    "What most people get wrong about X",
  ],
  convert: [
    "A specific client result from the last 90 days",
    "A before/after transformation I helped create",
    "The outcome my best clients consistently get",
  ],
};

const LM_CHIPS = {
  0: ["LinkedIn Hook Templates", "Client Onboarding Checklist", "90-Day LinkedIn Playbook"],
  1: [],
  2: [],
  3: ["HOOKS", "TEMPLATE", "PLAYBOOK"],
};

const suggestionCache = {};

/* ── Type selection ──────────────────────────────────────────── */
typeChips.forEach(chip => chip.addEventListener('click', () => selectType(chip.dataset.type)));
chatChangeBtn.addEventListener('click', resetType);

function selectType(type) {
  selectedType = type;
  chatStep     = 0;
  chatAnswers  = {};

  typeSelectorSection.style.display = 'none';
  processingScreen.classList.remove('visible');
  guidedChat.classList.add('visible');

  chatTypeLabel.textContent = CHAT_CONFIGS[type].label;
  hideChatError();
  hideSubstanceWarning();

  chat.init(type);
}

function resetType() {
  selectedType = null;
  chatStep     = 0;
  chatAnswers  = {};

  guidedChat.classList.remove('visible');
  processingScreen.classList.remove('visible');
  typeSelectorSection.style.display = '';

  chatThread.innerHTML     = '';
  chatInput.value          = '';
  chatInput.style.height   = '';
  chatInput.disabled       = false;
  chatSendBtn.disabled     = false;
  attachBtn.disabled       = false;
  chatInput.classList.remove('error');
  hideChatError();
  hideSubstanceWarning();

  markRecommendedChip();
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

    markRecommendedChip();
  } catch { /* non-fatal */ }
}

function markRecommendedChip() {
  typeChips.forEach(chip => {
    chip.classList.toggle('type-chip--recommended', chip.dataset.type === mixRecommended);
  });
}

/* ── Chat module ─────────────────────────────────────────────── */
const chat = (() => {
  let _type        = null;
  let _lmProofMode = 'metric'; // 'metric' | 'description' for LM step 2

  function addBot(text, opts = {}) {
    const div = document.createElement('div');
    div.className = 'chat-bubble-bot';
    div.textContent = text;
    if (opts.hasEscape) {
      const btn = document.createElement('button');
      btn.style.cssText = 'display:block;margin-top:10px;font-size:0.8125rem;color:var(--brand);' +
        'font-weight:500;background:none;border:none;padding:0;cursor:pointer;' +
        'text-decoration:underline;font-family:var(--font-sans);text-align:left;';
      btn.textContent = 'No metric yet? Describe who it worked for →';
      btn.addEventListener('click', () => {
        _lmProofMode          = 'description';
        div.textContent       = 'Who has this worked for? Describe the person or situation.';
        chatInput.placeholder = 'e.g. "SaaS founders who want to grow their LinkedIn without paid ads"';
        chatInput.value       = '';
        chatInput.focus();
        hideChatError();
      });
      div.appendChild(btn);
    }
    chatThread.appendChild(div);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function addUser(text) {
    const div = document.createElement('div');
    div.className = 'chat-bubble-user';
    div.textContent = text;
    chatThread.appendChild(div);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function setInputState(stepConfig) {
    chatInput.placeholder = stepConfig.placeholder || '';
    if (stepConfig.multiline) {
      chatInput.rows           = 4;
      chatInput.style.minHeight = '100px';
    } else {
      chatInput.rows           = 1;
      chatInput.style.minHeight = '44px';
    }
    chatInput.value        = '';
    chatInput.style.height = '';
    chatInput.classList.remove('error');
  }

  function updateSendBtn() {
    const cfg    = CHAT_CONFIGS[_type];
    const isLast = chatStep >= cfg.steps.length - 1;
    chatSendBtn.textContent = (_type === 'lead_magnet' && !isLast)
      ? 'Next →'
      : (_type === 'lead_magnet' ? 'Write my lead magnet →' : 'Write the post →');
  }

  async function loadSuggestions(type, step) {
    if (type === 'lead_magnet') {
      const chips = LM_CHIPS[step] || [];
      if (chips.length) renderSuggestions(chips);
      return;
    }

    if (step !== 0) return;

    if (suggestionCache[type]) {
      renderSuggestions(suggestionCache[type]);
      return;
    }

    try {
      const res  = await fetch(`/api/vault/suggest-topics?post_type=${type}`, { headers: apiHeaders() });
      const data = await res.json();
      if (data.ok && data.topics?.length) {
        const chips = data.topics.map(t => t.title);
        suggestionCache[type] = chips;
        renderSuggestions(chips);
      } else {
        renderSuggestions(FALLBACK_CHIPS[type] || []);
      }
    } catch {
      renderSuggestions(FALLBACK_CHIPS[type] || []);
    }
  }

  function renderSuggestions(chips) {
    if (!chips.length) return;
    const row = document.createElement('div');
    row.className = 'suggestion-chips-row';
    chips.forEach(label => {
      const btn = document.createElement('button');
      btn.type      = 'button';
      btn.className = 'suggestion-chip';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        chatInput.value        = label;
        chatInput.style.height = 'auto';
        chatInput.style.height = chatInput.scrollHeight + 'px';
        chatInput.focus();
      });
      row.appendChild(btn);
    });
    chatThread.appendChild(row);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function init(type) {
    _type        = type;
    _lmProofMode = 'metric';

    chatThread.innerHTML = '';

    const step0 = CHAT_CONFIGS[type].steps[0];
    addBot(step0.question, { hasEscape: step0.hasEscape });
    setInputState(step0);
    updateSendBtn();
    chatInput.focus();

    loadSuggestions(type, 0);
  }

  function advance() {
    hideChatError();
    hideSubstanceWarning();

    const val  = chatInput.value.trim();
    const cfg  = CHAT_CONFIGS[_type];

    if (!val) {
      showChatInputError('Add something before continuing.');
      chatInput.focus();
      return;
    }

    if (_type === 'lead_magnet') {
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
    } else {
      if (val.length < 80) {
        showChatInputError('Add more of your own words — a few sentences gives us more to work with.');
        chatInput.focus();
        return;
      }
    }

    addUser(val);

    if (_type === 'lead_magnet') {
      if (chatStep === 0)      chatAnswers.resourceName = val;
      else if (chatStep === 1) chatAnswers.deliverables = val.split('\n').map(l => l.trim()).filter(Boolean);
      else if (chatStep === 2) { chatAnswers.proof = val; chatAnswers.proofMode = _lmProofMode; }
      else if (chatStep === 3) chatAnswers.keyword = val.toUpperCase();
    } else {
      chatAnswers.step0 = val;
    }

    chatStep++;

    if (chatStep < cfg.steps.length) {
      const nextStep = cfg.steps[chatStep];
      setTimeout(() => {
        addBot(nextStep.question, { hasEscape: nextStep.hasEscape });
        setInputState(nextStep);
        updateSendBtn();
        loadSuggestions(_type, chatStep);
        chatInput.focus();
      }, 300);
    } else {
      (_type === 'lead_magnet') ? triggerLeadMagnetGenerate() : triggerGenerate();
    }
  }

  return { init, advance };
})();

/* ── Chat input wiring ───────────────────────────────────────── */
chatSendBtn.addEventListener('click', () => chat.advance());

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = chatInput.scrollHeight + 'px';
  chatInput.classList.remove('error');
  hideChatError();
  hideSubstanceWarning();
});

chatInput.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const step = CHAT_CONFIGS[selectedType]?.steps[chatStep];
  if (!step?.multiline || e.metaKey || e.ctrlKey) {
    e.preventDefault();
    chat.advance();
  }
});

/* ── Attachment ──────────────────────────────────────────────── */
attachBtn.addEventListener('click', () => attachFileInput.click());
attachFileInput.addEventListener('change', () => {
  const file = attachFileInput.files?.[0];
  attachFileInput.value = '';
  if (file) handleAttachment(file);
});

const ATTACH_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);

async function handleAttachment(file) {
  if (!ATTACH_MIME.has(file.type)) {
    showChatError('Supported formats: PDF, Word (.docx), plain text (.txt)');
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    showChatError('File is too large — maximum 25 MB.');
    return;
  }

  const userDiv = document.createElement('div');
  userDiv.className   = 'chat-bubble-user';
  userDiv.textContent = `📎 ${file.name} attached`;
  chatThread.appendChild(userDiv);
  chatThread.scrollTop = chatThread.scrollHeight;

  if (selectedType === 'lead_magnet') {
    // For LM: note the attachment and continue the guided flow
    return;
  }

  // 1-turn types: go straight to from-doc generation
  chatInput.disabled   = true;
  chatSendBtn.disabled = true;
  attachBtn.disabled   = true;
  showProcessingScreen(file.name, selectedType);

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 90_000);

  try {
    const res = await fetch('/api/generate/from-doc', {
      method:  'POST',
      headers: { ...apiHeaders(), 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) },
      body:    file,
      signal:  controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json();

    if (!res.ok || !data.ok) {
      const err = new Error(data.error || 'generation_failed');
      if (data.error === 'plan_limit_exceeded') { err.planCurrent = data.current; err.planLimit = data.limit; }
      throw err;
    }

    finaliseProcessingSteps(data);
    await sleep(600);
    window.location.href = `/editor/${encodeURIComponent(data.id)}`;

  } catch (err) {
    clearTimeout(timeoutId);
    hideProcessingScreen();
    chatInput.disabled   = false;
    chatSendBtn.disabled = false;
    attachBtn.disabled   = false;

    if (err.name === 'AbortError') {
      showChatError('This is taking longer than expected. <a href="#">Try again →</a>');
    } else if (err.message === 'plan_limit_exceeded') {
      const used = (err.planCurrent != null && err.planLimit != null)
        ? ` You've used ${err.planCurrent} of ${err.planLimit} this month.` : '';
      showChatError(`You've reached the free plan limit.${used} <button type="button" onclick="window.PricingModal?.open()" style="background:none;border:none;padding:0;color:var(--brand);font-weight:600;cursor:pointer;font-size:inherit">Upgrade to Pro →</button>`);
    } else {
      showChatError('Something went wrong processing your file. <a href="#">Try again →</a>');
    }
  }
}

/* ── Generate (Reach / Trust / Convert) ─────────────────────── */
chatGenerateAnyway.addEventListener('click', () => triggerGenerate({ skipSubstanceCheck: true }));

async function triggerGenerate(opts = {}) {
  hideChatError();
  hideSubstanceWarning();

  const idea = chatAnswers.step0 || '';
  showProcessingScreen(idea, selectedType);

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 90_000);

  try {
    const body = { path: 'idea', raw_idea: idea, post_type: selectedType || null };
    if (opts.skipSubstanceCheck) body.skip_substance_check = true;

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
      showChatError(`You've reached the free plan limit.${used} <button type="button" onclick="window.PricingModal?.open()" style="background:none;border:none;padding:0;color:var(--brand);font-weight:600;cursor:pointer;font-size:inherit">Upgrade to Pro →</button>`);
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
  guidedChat.classList.remove('visible');
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
  guidedChat.classList.add('visible');
}

/* ── Error helpers ───────────────────────────────────────────── */
function showChatError(html) {
  chatError.innerHTML = html;
  chatError.classList.add('visible');
  chatError.querySelector('a[href="#"]')?.addEventListener('click', e => { e.preventDefault(); triggerGenerate(); });
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

/* ── Init ────────────────────────────────────────────────────── */
(async function init() {
  await window.scouthookAuthReady;
  await loadMixRecommendation();

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
    selectType('reach');
    chatInput.value        = urlIdea;
    chatInput.style.height = 'auto';
    chatInput.style.height = chatInput.scrollHeight + 'px';
  }
})();

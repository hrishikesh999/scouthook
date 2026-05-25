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
let selectedVaultIdeaId = null; // set when user picks a vault idea in Q1

/* ── DOM refs ────────────────────────────────────────────────── */
const typeSelectorSection = document.getElementById('type-selector-section');
const typeChips           = document.querySelectorAll('.type-chip');
const guidedChat          = document.getElementById('guided-chat');
const chatTypeTitle       = document.getElementById('chat-type-title');
const chatTypeDesc        = document.getElementById('chat-type-desc');
const chatChangeBtn       = document.getElementById('chat-change-btn');
const chatThread          = document.getElementById('chat-thread');
const chatInput           = document.getElementById('chat-input');
const chatSendBtn         = document.getElementById('chat-send-btn');
const chatError           = document.getElementById('chat-error');
const chatSubstanceWarn   = document.getElementById('chat-substance-warning');
const chatSubstanceText   = document.getElementById('chat-substance-text');
const chatGenerateAnyway  = document.getElementById('chat-generate-anyway');
const processingScreen    = document.getElementById('processing-screen');
const chatInputRow        = document.querySelector('.chat-input-row');
const skipRow             = document.getElementById('skip-row');
const skipBtn             = document.getElementById('skip-btn');
const tensionConfirm      = document.getElementById('tension-confirm');
const tensionInput        = document.getElementById('tension-input');
const tensionGapText      = document.getElementById('tension-gap-text');
const tensionGenerateBtn  = document.getElementById('tension-generate-btn');
const tensionGenerateAnywayBtn = document.getElementById('tension-generate-anyway-btn');

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

function assembleExtractionInputs(postType, answers, tensionStatement) {
  const parts = [];
  if (tensionStatement) parts.push(`CENTRAL TENSION: ${tensionStatement}`);
  if (postType === 'reach') {
    if (answers.moment) parts.push(`WHAT HAPPENED: ${answers.moment}`);
    if (answers.lesson) parts.push(`WHAT TO DO: ${answers.lesson}`);
    if (answers.angle)  parts.push(`WHAT MOST PEOPLE GET WRONG: ${answers.angle}`);
  } else if (postType === 'trust') {
    if (answers.contrarian) parts.push(`THE BELIEF: ${answers.contrarian}`);
    if (answers.proof)      parts.push(`THE PROOF: ${answers.proof}`);
    if (answers.audience)   parts.push(`WHO THIS IS FOR: ${answers.audience}`);
  } else if (postType === 'convert') {
    if (answers.result)    parts.push(`THE RESULT: ${answers.result}`);
    if (answers.mechanism) parts.push(`WHAT DROVE IT: ${answers.mechanism}`);
    if (answers.target)    parts.push(`WHO SHOULD ACT: ${answers.target}`);
  }
  return parts.join('\n\n');
}

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

  chatTypeTitle.textContent = CHAT_CONFIGS[type].chatTitle;
  chatTypeDesc.textContent  = CHAT_CONFIGS[type].chatDesc;
  hideChatError();
  hideSubstanceWarning();

  chat.init(type);
}

function resetType() {
  selectedType        = null;
  chatStep            = 0;
  chatAnswers         = {};
  selectedVaultIdeaId = null;

  guidedChat.classList.remove('visible');
  processingScreen.classList.remove('visible');
  typeSelectorSection.style.display = '';

  chatThread.innerHTML     = '';
  chatInput.value          = '';
  chatInput.style.height   = '';
  chatInput.disabled       = false;
  chatSendBtn.disabled     = false;
  chatInput.classList.remove('error');
  skipRow.style.display  = 'none';
  chat.hideTensionConfirm();
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
  let _type           = null;
  let _lmProofMode    = 'metric'; // 'metric' | 'description' for LM step 2
  let _tensionPromise = null;

  function addBot(text, opts = {}) {
    const div = document.createElement('div');
    div.className = 'chat-bubble-bot';

    if (opts.label) {
      const labelEl = document.createElement('div');
      labelEl.className = 'chat-bubble-label';
      labelEl.textContent = opts.label;
      div.appendChild(labelEl);
    }

    const mainEl = document.createElement('div');
    mainEl.className = 'chat-bubble-main';
    mainEl.textContent = text;
    div.appendChild(mainEl);

    if (opts.nudge) {
      const nudgeEl = document.createElement('div');
      nudgeEl.className = 'chat-bubble-nudge';
      nudgeEl.textContent = opts.nudge;
      div.appendChild(nudgeEl);
    }

    if (opts.example) {
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'chat-bubble-example-toggle';
      toggleBtn.textContent = 'See what works well →';

      const exampleBody = document.createElement('div');
      exampleBody.className = 'chat-bubble-example-body';
      exampleBody.textContent = opts.example;

      toggleBtn.addEventListener('click', () => {
        const open = exampleBody.classList.toggle('visible');
        toggleBtn.textContent = open ? 'Hide examples ↑' : 'See what works well →';
        chatThread.scrollTop = chatThread.scrollHeight;
      });

      div.appendChild(toggleBtn);
      div.appendChild(exampleBody);
    }

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
      chatSendBtn.textContent = 'Continue →';
    }
  }

  async function _loadVaultIdeas(type, bubbleDiv) {
    try {
      const res   = await fetch(`/api/vault/ideas?status=fresh&funnel_type=${type}`, { headers: apiHeaders() });
      const data  = await res.json();
      const ideas = (data.ideas || []).slice(0, 3);

      if (ideas.length) {
        // ── Vault ideas found ──────────────────────────────────────────────────
        const toggleBtn = document.createElement('button');
        toggleBtn.className   = 'chat-bubble-vault-toggle';
        toggleBtn.textContent = 'From your vault →';

        const vaultBody = document.createElement('div');
        vaultBody.className = 'chat-bubble-vault-body';

        ideas.forEach(idea => {
          const item = document.createElement('button');
          item.type      = 'button';
          item.className = 'vault-idea-item';

          const preview = document.createElement('div');
          preview.className   = 'vault-idea-preview';
          preview.textContent = idea.hook_preview || idea.seed_text.slice(0, 100);
          item.appendChild(preview);

          if (idea.source_ref) {
            const source = document.createElement('div');
            source.className   = 'vault-idea-source';
            source.textContent = idea.source_ref;
            item.appendChild(source);
          }

          item.addEventListener('click', () => {
            chatInput.value        = idea.seed_text;
            chatInput.style.height = 'auto';
            chatInput.style.height = chatInput.scrollHeight + 'px';
            chatInput.classList.remove('error');
            hideChatError();
            chatInput.focus();
            selectedVaultIdeaId   = idea.id;
            vaultBody.classList.remove('visible');
            toggleBtn.textContent = 'From your vault →';
            chatThread.scrollTop  = chatThread.scrollHeight;
          });

          vaultBody.appendChild(item);
        });

        toggleBtn.addEventListener('click', () => {
          const open = vaultBody.classList.toggle('visible');
          toggleBtn.textContent = open ? 'Hide vault ideas ↑' : 'From your vault →';
          chatThread.scrollTop  = chatThread.scrollHeight;
        });

        bubbleDiv.appendChild(toggleBtn);
        bubbleDiv.appendChild(vaultBody);
        chatThread.scrollTop = chatThread.scrollHeight;
        return;
      }

      // ── No vault ideas — fall back to profile-grounded suggestions ───────────
      const sugRes  = await fetch(`/api/vault/suggest-topics?post_type=${type}`, { headers: apiHeaders() });
      const sugData = await sugRes.json();
      const topics  = (sugData.topics || []).slice(0, 3);
      if (!topics.length) return;

      const toggleBtn = document.createElement('button');
      toggleBtn.className   = 'chat-bubble-vault-toggle';
      toggleBtn.textContent = 'Need a starting point? →';

      const sugBody = document.createElement('div');
      sugBody.className = 'chat-bubble-vault-body';

      topics.forEach(topic => {
        const item = document.createElement('button');
        item.type      = 'button';
        item.className = 'vault-idea-item';

        const preview = document.createElement('div');
        preview.className   = 'vault-idea-preview';
        preview.textContent = topic.title;
        item.appendChild(preview);

        if (topic.description) {
          const desc = document.createElement('div');
          desc.className   = 'vault-idea-source';
          desc.textContent = topic.description;
          item.appendChild(desc);
        }

        item.addEventListener('click', () => {
          // Fill Q1 with the angle/tension description as a concrete starting point
          chatInput.value        = topic.description || topic.title;
          chatInput.style.height = 'auto';
          chatInput.style.height = chatInput.scrollHeight + 'px';
          chatInput.classList.remove('error');
          hideChatError();
          chatInput.focus();
          // No vault_idea_id — profile suggestions have no chunk grounding
          sugBody.classList.remove('visible');
          toggleBtn.textContent = 'Need a starting point? →';
          chatThread.scrollTop  = chatThread.scrollHeight;
        });

        sugBody.appendChild(item);
      });

      toggleBtn.addEventListener('click', () => {
        const open = sugBody.classList.toggle('visible');
        toggleBtn.textContent = open ? 'Hide suggestions ↑' : 'Need a starting point? →';
        chatThread.scrollTop  = chatThread.scrollHeight;
      });

      bubbleDiv.appendChild(toggleBtn);
      bubbleDiv.appendChild(sugBody);
      chatThread.scrollTop = chatThread.scrollHeight;
    } catch { /* non-fatal */ }
  }

  function fireTensionExtraction(answer) {
    _tensionPromise = fetch('/api/generate/extract-tension', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify({ post_type: _type, answer }),
    })
      .then(r => r.json())
      .then(d => d.ok ? { tension: d.tension, missing: d.missing } : { tension: null, missing: null })
      .catch(() => ({ tension: null, missing: null }));
  }

  async function showTensionConfirm() {
    chatInputRow.style.display  = 'none';
    skipRow.style.display       = 'none';
    chatInput.disabled          = true;
    chatSendBtn.disabled        = true;

    const result = await (_tensionPromise || Promise.resolve({ tension: null, missing: null }));

    tensionConfirm.classList.add('visible');

    if (result.tension) {
      tensionInput.style.display    = '';
      tensionGapText.style.display  = 'none';
      tensionInput.value            = result.tension;
      tensionGenerateAnywayBtn.style.display = 'none';
    } else {
      tensionInput.style.display    = 'none';
      tensionGapText.style.display  = '';
      tensionGapText.textContent    = result.missing
        ? `We need a bit more. ${result.missing}`
        : "We couldn't identify a clear tension yet — but you can still generate with what you have.";
      tensionGenerateAnywayBtn.style.display = '';
    }
  }

  function hideTensionConfirm() {
    tensionConfirm.classList.remove('visible');
    tensionInput.style.display             = 'none';
    tensionGapText.style.display           = 'none';
    tensionGenerateAnywayBtn.style.display = 'none';
    chatInputRow.style.display             = '';
    chatInput.disabled    = false;
    chatSendBtn.disabled  = false;
  }

  function init(type) {
    _type               = type;
    _lmProofMode        = 'metric';
    _tensionPromise     = null;
    selectedVaultIdeaId = null;

    chatThread.innerHTML = '';
    hideTensionConfirm();
    skipRow.style.display = 'none';

    if (type === 'lead_magnet') {
      const step0 = CHAT_CONFIGS.lead_magnet.steps[0];
      addBot(step0.question, { hasEscape: step0.hasEscape });
      setInputState(step0);
    } else {
      const q0    = EXTRACTION_QUESTIONS[type][0];
      const q0Div = addBot(q0.question, { label: q0.label, example: q0.example });
      setInputState({ placeholder: q0.placeholder, multiline: true });
      _loadVaultIdeas(type, q0Div);
    }
    updateSendBtn();
    chatInput.focus();
  }

  function advance() {
    hideChatError();
    hideSubstanceWarning();

    const val = chatInput.value.trim();

    // ── Lead magnet path (unchanged logic) ─────────────────────
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

    // ── Extraction path (reach / trust / convert) ───────────────
    const questions = EXTRACTION_QUESTIONS[_type];
    const currentQ  = questions[chatStep];

    if (!val) {
      showChatInputError(currentQ.errorMsg || 'Add something before continuing.');
      chatInput.focus();
      return;
    }
    if (currentQ.minChars && val.length < currentQ.minChars) {
      showChatInputError(currentQ.errorMsg || `Add a bit more — aim for at least ${currentQ.minChars} characters.`);
      chatInput.focus();
      return;
    }

    addUser(val);
    chatAnswers[currentQ.key] = val;

    if (chatStep === 0) fireTensionExtraction(val);

    chatStep++;
    skipRow.style.display = 'none';

    if (chatStep < questions.length) {
      const nextQ = questions[chatStep];
      setTimeout(() => {
        addBot(nextQ.question, { label: nextQ.label, nudge: nextQ.nudge });
        setInputState({ placeholder: nextQ.placeholder, multiline: true });
        if (!nextQ.required) skipRow.style.display = '';
        updateSendBtn();
        chatInput.value = '';
        chatInput.focus();
      }, 300);
    } else {
      showTensionConfirm();
    }
  }

  function skip() {
    hideChatError();
    const questions = EXTRACTION_QUESTIONS[_type];
    const currentQ  = questions[chatStep];
    chatAnswers[currentQ.key] = null;
    chatStep++;
    skipRow.style.display = 'none';

    if (chatStep < questions.length) {
      const nextQ = questions[chatStep];
      setTimeout(() => {
        addBot(nextQ.question, { label: nextQ.label, nudge: nextQ.nudge });
        setInputState({ placeholder: nextQ.placeholder, multiline: true });
        if (!nextQ.required) skipRow.style.display = '';
        updateSendBtn();
        chatInput.value = '';
        chatInput.focus();
      }, 300);
    } else {
      showTensionConfirm();
    }
  }

  return { init, advance, skip, hideTensionConfirm };
})();

/* ── Chat input wiring ───────────────────────────────────────── */
chatSendBtn.addEventListener('click', () => chat.advance());
skipBtn.addEventListener('click', () => chat.skip());
tensionGenerateBtn.addEventListener('click', () => {
  const ts = tensionInput.value.trim() || null;
  triggerGenerate({ tensionStatement: ts });
});
tensionGenerateAnywayBtn.addEventListener('click', () => {
  triggerGenerate({ skipSubstanceCheck: true });
});

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


/* ── Generate (Reach / Trust / Convert) ─────────────────────── */
chatGenerateAnyway.addEventListener('click', () => {
  const ts = tensionConfirm.classList.contains('visible') ? (tensionInput.value.trim() || null) : null;
  triggerGenerate({ skipSubstanceCheck: true, tensionStatement: ts });
});

async function triggerGenerate(opts = {}) {
  hideChatError();
  hideSubstanceWarning();

  const isExtraction = selectedType && selectedType !== 'lead_magnet';
  const tensionStmt  = opts.tensionStatement !== undefined ? opts.tensionStatement : null;
  const idea         = isExtraction
    ? assembleExtractionInputs(selectedType, chatAnswers, tensionStmt)
    : (chatAnswers.step0 || '');

  showProcessingScreen(idea, selectedType);

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 90_000);

  try {
    const body = { path: 'idea', raw_idea: idea, post_type: selectedType || null };
    if (tensionStmt)             body.tension_statement   = tensionStmt;
    if (opts.skipSubstanceCheck) body.skip_substance_check = true;
    if (selectedVaultIdeaId)     body.vault_idea_id        = selectedVaultIdeaId;

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

/* generate.js — guided chat redesign */

/* ── Helpers ─────────────────────────────────────────────────── */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Read a text/event-stream response, dispatching events to named handlers. */
async function readSSEStream(response, { onStep, onToken, onDone, onError } = {}) {
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer   = '';
  let curEvent = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIdx;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        if (line.startsWith('event: ')) {
          curEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ') && curEvent) {
          try {
            const data = JSON.parse(line.slice(6));
            if (curEvent === 'step')  onStep?.(data);
            if (curEvent === 'token') onToken?.(data);
            if (curEvent === 'done')  onDone?.(data);
            if (curEvent === 'error') onError?.(data);
          } catch { /* malformed data — skip */ }
          curEvent = null;
        } else if (line === '') {
          curEvent = null;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/* ── State ───────────────────────────────────────────────────── */
let selectedType        = null; // 'reach'|'trust'|'convert'
let chatStep            = 0;
let chatAnswers         = {};
let mixRecommended      = null;
let selectedVaultIdeaId = null; // set when user picks a vault idea
let _tensionResult      = null; // { tension, missing } from silent extraction
let _tensionDebounce    = null; // debounce timer for extraction on input
let _nichePlaceholders  = [];   // niche-specific placeholder examples loaded from profile
let _nicheProfile       = null; // cached profile for niche-aware nudge (content_niche)
let _shownVaultIds      = new Set(); // vault idea IDs shown this session — rotates on each click
let _shownAITopics      = [];        // AI topic titles shown this session — passed as exclusion list
let _shownIdeaHooks     = [];        // idea engine hook lines shown — passed as exclude_hooks
let _currentPostTypeFilter = null;   // active filter chip in the idea engine
let _clarificationMode  = false;     // true while waiting for clarification answer from user
let _originalIdea       = '';        // the user's original thin input, preserved during clarification

/* ── DOM refs ────────────────────────────────────────────────── */
const guidedChat          = document.getElementById('guided-chat');
const intentBtns          = document.querySelectorAll('.intent-card[data-type]');
const chatThread          = document.getElementById('chat-thread');
const chatInput           = document.getElementById('chat-input');
const chatSendBtn         = document.getElementById('chat-send-btn');
const chatError           = document.getElementById('chat-error');
const chatSubstanceWarn   = document.getElementById('chat-substance-warning');
const chatSubstanceText   = document.getElementById('chat-substance-text');
const chatImproveInput    = document.getElementById('chat-improve-input');
const processingScreen    = document.getElementById('processing-screen');
const procPreview         = document.getElementById('proc-preview');
const procPreviewText     = document.getElementById('proc-preview-text');
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

// Lead magnet chip
// Get ideas chip
document.getElementById('intent-ideas')?.addEventListener('click', () => {
  document.getElementById('intent-ideas').classList.add('active');
  loadVaultPanel(null, () => {
    document.getElementById('intent-ideas')?.classList.remove('active');
  }, { reset: true });
});

function selectType(type) {
  selectedType        = type;
  chatStep            = 0;
  chatAnswers         = {};
  selectedVaultIdeaId = null;
  _tensionResult      = null;
  clearTimeout(_tensionDebounce);

  document.getElementById('intent-ideas')?.classList.remove('active');

  hideChatError();
  hideSubstanceWarning();
  hideSpecificityNudge();

  chat.init(type);
  applyNichePlaceholder();
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

function markRecommendedBtn() { /* no-op — lead magnet chip removed */ }

/* ── Vault panel / Idea Engine ───────────────────────────────── */

// Active tab: 'fresh' | 'saved'
let _ideaTab = 'fresh';

async function loadVaultPanel(type, onItemSelected, { reset = false } = {}) {
  if (reset) { _shownIdeaHooks = []; _currentPostTypeFilter = null; _ideaTab = 'fresh'; }
  const panel = document.getElementById('vault-panel');
  if (!panel) return;
  panel.style.display = '';

  if (_ideaTab === 'saved') {
    await loadSavedIdeas(panel, onItemSelected);
  } else {
    await loadFreshIdeas(panel, type, onItemSelected);
  }
}

async function loadFreshIdeas(panel, type, onItemSelected) {
  renderIdeaLoadingState(panel, 'fresh', onItemSelected);

  try {
    const postType = _currentPostTypeFilter || mixRecommended || type || null;
    const params = new URLSearchParams();
    if (postType) params.set('post_type', postType);
    if (_shownIdeaHooks.length) params.set('exclude_hooks', JSON.stringify(_shownIdeaHooks.slice(-12)));

    const res   = await fetch(`/api/vault/generate-ideas?${params}`, { headers: apiHeaders() });
    const data  = await res.json();
    const ideas = data.ideas || [];

    if (!ideas.length) { panel.style.display = 'none'; panel.innerHTML = ''; return; }

    _shownIdeaHooks.push(...ideas.map(i => i.hook));
    renderIdeaEngine(panel, ideas, data.icp_summary || '', 'fresh', onItemSelected);
  } catch { panel.style.display = 'none'; panel.innerHTML = ''; }
}

async function loadSavedIdeas(panel, onItemSelected) {
  renderIdeaLoadingState(panel, 'saved', onItemSelected);

  try {
    const res  = await fetch('/api/vault/ideas?source=idea_engine&status=saved', { headers: apiHeaders() });
    const data = await res.json();
    // Map DB rows — seed_text is stored as JSON for idea_engine rows
    const ideas = (data.ideas || []).map(row => {
      let parsed = {};
      try { parsed = JSON.parse(row.seed_text); } catch { parsed = {}; }
      return {
        id:            row.id,
        hook:          row.hook_preview || parsed.hook || row.seed_text.split('\n')[0] || '',
        angle:         parsed.angle     || row.seed_text.split('\n\n')[1] || row.seed_text,
        story_prompt:  parsed.story_prompt || '',
        icp_resonance: row.source_ref   || '',
        post_type:     row.funnel_type  || 'reach',
        vault_anchor:  null,
        tension_type:  row.hook_archetype || null,
        saved:         true,
      };
    });

    if (!ideas.length) {
      renderIdeaEmptySaved(panel, onItemSelected);
      return;
    }
    renderIdeaEngine(panel, ideas, '', 'saved', onItemSelected);
  } catch { panel.style.display = 'none'; panel.innerHTML = ''; }
}

function renderIdeaTabBar(activeTab, onTabSwitch) {
  return `<div class="idea-tab-bar">
    <button class="idea-tab${activeTab === 'fresh' ? ' active' : ''}" type="button" data-tab="fresh">Fresh ideas</button>
    <button class="idea-tab${activeTab === 'saved' ? ' active' : ''}" type="button" data-tab="saved">Saved</button>
  </div>`;
}

function renderIdeaLoadingState(panel, activeTab, onItemSelected) {
  panel.innerHTML = `
    ${renderIdeaTabBar(activeTab)}
    <div class="idea-engine-loading">
      <span class="idea-spinner"></span>
      <span>${activeTab === 'saved' ? 'Loading saved ideas…' : 'Generating ideas for your audience…'}</span>
    </div>`;
  panel.querySelectorAll('.idea-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _ideaTab = tab.dataset.tab;
      loadVaultPanel(null, onItemSelected);
    });
  });
}

function renderIdeaEmptySaved(panel, onItemSelected) {
  panel.innerHTML = `
    ${renderIdeaTabBar('saved')}
    <p class="idea-empty-saved">No saved ideas yet. Generate fresh ideas and bookmark the ones you want to come back to.</p>`;
  panel.querySelectorAll('.idea-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _ideaTab = tab.dataset.tab;
      loadVaultPanel(null, onItemSelected);
    });
  });
}

function renderIdeaEngine(panel, ideas, icpSummary, activeTab, onItemSelected) {
  const PILL = {
    reach:   { bg: '#eff6ff', color: '#1d4ed8', label: 'Reach' },
    trust:   { bg: '#f0fdf4', color: '#166534', label: 'Trust' },
    convert: { bg: '#fff7ed', color: '#9a3412', label: 'Convert' },
  };

  const isFreshTab = activeTab === 'fresh';

  const filterRow = isFreshTab ? (() => {
    const activeFilter = _currentPostTypeFilter;
    return `<div class="idea-filter-chips">${['all','reach','trust','convert'].map(t =>
      `<button class="idea-filter-chip${(!activeFilter && t === 'all') || activeFilter === t ? ' active' : ''}" type="button" data-filter="${t}">${t === 'all' ? 'All' : t.charAt(0).toUpperCase() + t.slice(1)}</button>`
    ).join('')}</div>`;
  })() : '';

  const cards = ideas.map((idea, idx) => {
    const pill = PILL[idea.post_type] || PILL.reach;
    const isSaved = !!idea.saved;
    return `<div class="idea-engine-card-wrap" data-idx="${idx}">
      <button class="idea-engine-card" type="button" data-idx="${idx}">
        <span class="idea-hook">${escapeHtml(idea.hook)}</span>
        <span class="idea-angle">${escapeHtml(idea.angle)}</span>
        ${idea.icp_resonance ? `<span class="idea-icp-resonance">${escapeHtml(idea.icp_resonance)}</span>` : ''}
        <span class="idea-card-footer">
          <span class="idea-type-pill" style="background:${pill.bg};color:${pill.color}">${pill.label}</span>
          ${idea.vault_anchor ? '<span class="idea-vault-badge">From your vault</span>' : ''}
        </span>
      </button>
      <button class="idea-bookmark${isSaved ? ' saved' : ''}" type="button" data-idx="${idx}" aria-label="${isSaved ? 'Unsave idea' : 'Save idea'}" title="${isSaved ? 'Remove from saved' : 'Save for later'}">
        ${isSaved ? '★' : '☆'}
      </button>
    </div>`;
  }).join('');

  panel.innerHTML = `
    ${renderIdeaTabBar(activeTab)}
    <div class="idea-engine-header">
      ${icpSummary ? `<span class="idea-icp-summary">IDEAS FOR: ${escapeHtml(icpSummary)}</span>` : ''}
      ${filterRow}
    </div>
    <div class="idea-engine-grid">${cards}</div>
    ${isFreshTab ? `<button class="idea-load-more" type="button" id="idea-load-more-btn">Load more ideas →</button>` : ''}`;

  // Card click — expand into rich brief via Haiku, fill textarea, keep panel open
  panel.querySelectorAll('.idea-engine-card').forEach((btn, i) => {
    btn.addEventListener('click', async () => {
      const idea = ideas[i];

      // Immediate fill with hook + angle so textarea isn't empty while expanding
      const seedText = `${idea.hook}\n\n${idea.angle}`;
      chatInput.value        = seedText;
      chatInput.style.height = 'auto';
      chatInput.style.height = chatInput.scrollHeight + 'px';
      chatInput.classList.remove('error');
      hideChatError();
      chatInput.focus();

      // Highlight selected card
      panel.querySelectorAll('.idea-engine-card').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');

      // Expand into a rich brief if we have an ID
      if (idea.id) {
        showSpecificityNudge('Expanding idea into a post brief…');
        try {
          const r = await fetch(`/api/vault/brief-idea?id=${encodeURIComponent(idea.id)}`, { headers: apiHeaders() });
          const d = await r.json();
          if (d.ok && d.brief && d.brief.trim().length > 40) {
            // Only replace if the user hasn't started editing
            if (chatInput.value === seedText) {
              chatInput.value        = d.brief.trim();
              chatInput.style.height = 'auto';
              chatInput.style.height = chatInput.scrollHeight + 'px';
              chat.fireTensionExtraction(chatInput.value);
            }
          }
        } catch { /* non-fatal — keep hook+angle */ }
        hideSpecificityNudge();
        checkSpecificityNudge(chatInput.value.trim());
      } else if (seedText.length >= 30) {
        chat.fireTensionExtraction(seedText);
      }
      // Panel stays open
    });
  });

  // Bookmark toggle
  panel.querySelectorAll('.idea-bookmark').forEach((btn, i) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idea    = ideas[i];
      if (!idea.id) return;
      const isSaved = btn.classList.contains('saved');
      const newStatus = isSaved ? 'fresh' : 'saved';
      try {
        await fetch(`/api/vault/ideas/${idea.id}`, {
          method: 'PATCH',
          headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus }),
        });
        btn.classList.toggle('saved', !isSaved);
        btn.textContent   = isSaved ? '☆' : '★';
        btn.title         = isSaved ? 'Save for later' : 'Remove from saved';
        btn.setAttribute('aria-label', isSaved ? 'Save idea' : 'Unsave idea');
        idea.saved = !isSaved;
        // If we're on the saved tab and just unsaved, remove the card
        if (activeTab === 'saved' && isSaved) {
          btn.closest('.idea-engine-card-wrap')?.remove();
          const remaining = panel.querySelectorAll('.idea-engine-card-wrap');
          if (!remaining.length) renderIdeaEmptySaved(panel, onItemSelected);
        }
      } catch { /* non-fatal */ }
    });
  });

  // Filter chips (fresh tab only)
  panel.querySelectorAll('.idea-filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      _currentPostTypeFilter = chip.dataset.filter === 'all' ? null : chip.dataset.filter;
      loadFreshIdeas(panel, null, onItemSelected);
    });
  });

  // Tab switch
  panel.querySelectorAll('.idea-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _ideaTab = tab.dataset.tab;
      loadVaultPanel(null, onItemSelected);
    });
  });

  // Load more (fresh tab only)
  panel.querySelector('#idea-load-more-btn')?.addEventListener('click', () => {
    loadFreshIdeas(panel, null, onItemSelected);
  });

  panel.style.display = '';
}

function renderVaultPanel(panel, items, title, onItemSelected) {
  panel.innerHTML =
    `<div class="vault-panel-header"><span class="vault-panel-title">${escapeHtml(title)}</span></div>` +
    `<div class="vault-panel-items">${items.map((item, i) =>
      `<button class="vault-panel-item" type="button" data-idx="${i}">
        <span class="vault-item-title">${escapeHtml(item.label)}</span>${item.desc ? `
        <span class="vault-item-desc">${escapeHtml(item.desc)}</span>` : ''}
      </button>`
    ).join('')}</div>`;
  panel.querySelectorAll('.vault-panel-item').forEach((btn, i) => {
    btn.addEventListener('click', async () => {
      selectedVaultIdeaId = items[i].id;
      onItemSelected?.();

      // Fill immediately with seed_text for instant feedback
      chatInput.value        = items[i].text;
      chatInput.style.height = 'auto';
      chatInput.style.height = chatInput.scrollHeight + 'px';
      chatInput.classList.remove('error');
      hideChatError();
      chatInput.focus();
      if (items[i].text.length >= 30) chat.fireTensionExtraction(items[i].text);

      // Vault ideas: enrich from the source chunk in the background
      if (items[i].id && selectedType) {
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

  function addBot(text, opts = {}) {
    const div = document.createElement('div');
    div.className = 'chat-bubble-bot';

    const mainEl = document.createElement('div');
    mainEl.className = 'chat-bubble-main';
    mainEl.textContent = text;
    div.appendChild(mainEl);

    if (opts.hasSkip) {
      const skip = document.createElement('button');
      skip.style.cssText = 'display:block;margin-top:10px;font-size:0.8125rem;color:var(--text-muted);' +
        'background:none;border:none;padding:0;cursor:pointer;font-family:var(--font-sans);text-align:left;';
      skip.textContent = 'Skip — just generate →';
      skip.addEventListener('click', () => {
        _clarificationMode = false;
        triggerGenerate({ enrichedIdea: _originalIdea });
      });
      div.appendChild(skip);
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

  const ARROW_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;

  function updateSendBtn() {
    if (_clarificationMode) {
      chatSendBtn.innerHTML = 'Write my post →';
      chatSendBtn.classList.add('text-mode');
      chatSendBtn.setAttribute('aria-label', 'Generate post');
    } else {
      chatSendBtn.innerHTML = ARROW_SVG;
      chatSendBtn.classList.remove('text-mode');
      chatSendBtn.setAttribute('aria-label', 'Generate post');
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
    _tensionResult   = null;
    selectedVaultIdeaId = null;
    _clarificationMode  = false;
    _originalIdea       = '';

    chatThread.innerHTML = '';
    const vaultPanel = document.getElementById('vault-panel');

    chatThread.style.display = 'none';
    const q0 = EXTRACTION_QUESTIONS[type][0];
    chatInput.placeholder = q0.placeholder;
    chatInput.rows        = 4;
    chatInput.style.minHeight = '100px';
    chatInput.classList.remove('error');
    if (!prevType) {
      chatInput.value      = '';
      chatInput.style.height = '';
    } else {
      chatInput.style.height = 'auto';
      chatInput.style.height = chatInput.scrollHeight + 'px';
    }
    updateSendBtn();
    chatInput.focus();
  }

  function advance() {
    hideChatError();
    hideSubstanceWarning();

    const val = chatInput.value.trim();

    // ── Extraction path ──────────────────────────────────────────
    if (!val) { showChatInputError('Add something before generating.'); chatInput.focus(); return; }
    if (val.length < 15) { showChatInputError('Add a bit more to work with.'); chatInput.focus(); return; }

    // Waiting for clarification answer
    if (_clarificationMode) {
      _clarificationMode = false;
      addUser(val);
      chatInput.value = '';
      chatInput.style.height = '';
      const enrichedIdea = `${_originalIdea}\n\nMore context: ${val}`;
      triggerGenerate({ enrichedIdea });
      return;
    }

    // Rich enough — generate directly
    if (!needsClarification(val)) {
      if (!_tensionResult && val.length >= 30) fireTensionExtraction(val);
      triggerGenerate({});
      return;
    }

    // Thin input — ask one clarifying question
    _clarificationMode = true;
    _originalIdea      = val;
    addUser(val);
    chatThread.style.display = '';
    chatInput.value       = '';
    chatInput.style.height = '';
    chatInput.rows        = 2;
    chatInput.style.minHeight = '60px';
    updateSendBtn();

    fetchClarifyingQuestion(val).then(question => {
      addBot(question, { hasSkip: true });
      chatInput.focus();
    });
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
  if (selectedType) {
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
  if (_clarificationMode) {
    // Clarification answer: Enter submits
    if (!e.shiftKey) { e.preventDefault(); chat.advance(); }
    return;
  }
  if (selectedType) {
    // Extraction path: always multiline — only Cmd/Ctrl+Enter submits
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); chat.advance(); }
  }
});

/* ── Clarification helpers ───────────────────────────────────── */
/**
 * Pure JS check: does this input need a clarifying question before generation?
 * Returns true if the input is short AND lacks both a personal pronoun and a concrete anchor.
 */
function needsClarification(val) {
  if (val.length > 200) return false;           // long enough — generate directly
  const hasPersonal = /\b(i|we|my|our)\b/i.test(val);
  const hasAnchor   = /\d/.test(val)
    || /\b(stopped|quit|hired|fired|launched|built|closed|signed|refused|decided|doubled|tripled|lost|won|sent|called|walked|left|joined|pivoted|cut)\b/i.test(val);
  return !(hasPersonal && hasAnchor);           // needs BOTH personal + concrete anchor to skip
}

/** Haiku call: ask the backend for one smart clarifying question contextualised to the user's profile. */
async function fetchClarifyingQuestion(val) {
  try {
    const res  = await fetch('/api/generate/clarify', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify({ raw_idea: val }),
    });
    const data = await res.json();
    return data.question || "Can you give me one specific moment, number, or example that connects to this?";
  } catch {
    return "Can you give me one specific moment, number, or example that connects to this?";
  }
}

/* ── Generate ────────────────────────────────────────────────── */
chatImproveInput.addEventListener('click', () => {
  hideSubstanceWarning();
  chatInput.value = '';
  chatInput.style.height = '';
  chatInput.focus();
});

async function triggerGenerate(opts = {}) {
  hideChatError();
  hideSubstanceWarning();

  const idea          = opts.enrichedIdea || chatInput.value.trim();
  const tensionStmt   = opts.tensionStatement !== undefined
    ? opts.tensionStatement
    : (_tensionResult?.tension || null);
  const shouldStream  = !selectedVaultIdeaId;

  hideSpecificityNudge();
  showProcessingScreen(idea, selectedType, shouldStream);

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 90_000);

  try {
    const body = { path: 'idea', raw_idea: idea, post_type: selectedType || null };
    if (tensionStmt)                                    body.tension_statement    = tensionStmt;
    if (selectedVaultIdeaId)                            body.vault_idea_id        = selectedVaultIdeaId;
    if (opts.enrichedIdea || opts.skipSubstanceCheck)   body.skip_substance_check = true;
    if (shouldStream)                                   body.streaming            = true;

    const res = await fetch('/api/generate', {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify(body), signal: controller.signal,
    });
    clearTimeout(timeoutId);

    // ── SSE streaming path ──────────────────────────────────────────────────
    if (shouldStream && res.headers.get('content-type')?.startsWith('text/event-stream')) {
      let sseResult = null;
      let sseError  = null;

      await readSSEStream(res, {
        onStep(data) {
          const idx = { analyzing: 0, blueprint_done: 1, writing: 2, saving: 3 }[data.step];
          if (idx === undefined) return;
          // Finalize the previous step when a new one begins
          if (idx > 0) {
            const prev = document.getElementById(`proc-step-${idx - 1}`);
            if (prev && !prev.classList.contains('done')) {
              prev.classList.add('visible', 'done');
              prev.querySelector('.proc-step-icon').innerHTML = '✅';
            }
          }
          const el = document.getElementById(`proc-step-${idx}`);
          if (!el) return;
          el.classList.add('visible');
          if (data.label) el.querySelector('.proc-step-text').textContent = data.label;
          if (data.step === 'writing' || data.step === 'saving') {
            el.querySelector('.proc-step-icon').innerHTML = '<span class="proc-spinner"></span>';
          } else {
            el.classList.add('done');
            el.querySelector('.proc-step-icon').innerHTML = '✅';
          }
        },
        onToken(data) {
          if (!procPreview || !procPreviewText) return;
          procPreviewText.textContent += data.text;
          if (procPreview.style.display === 'none' || !procPreview.style.display) {
            procPreview.style.display = 'block';
          }
          procPreview.scrollTop = procPreview.scrollHeight;
        },
        onDone(data) {
          sseResult = data;
          finaliseProcessingSteps({ archetypeUsed: data.archetypeUsed, stage1Blueprint: data.stage1Blueprint });
        },
        onError(data) { sseError = data; },
      });

      if (sseError) {
        if (sseError.error === 'missing_substance') {
          const err = new Error('missing_substance');
          err.substancePrompt = sseError.prompt;
          err.substanceTier   = sseError.substance_tier;
          throw err;
        }
        const err = new Error(sseError.error || 'generation_failed');
        if (sseError.error === 'plan_limit_exceeded') { err.planCurrent = sseError.current; err.planLimit = sseError.limit; }
        throw err;
      }

      if (!sseResult?.post_id) throw new Error('stream_incomplete');

      await sleep(600);
      window.location.href = `/editor/${encodeURIComponent(sseResult.post_id)}`;
      return;
    }

    // ── Non-streaming fallback (vault, or SSE unavailable) ─────────────────
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const err = new Error(data.error || 'generation_failed');
      if (data.error === 'plan_limit_exceeded') { err.planCurrent = data.current; err.planLimit = data.limit; }
      if (data.error === 'missing_substance')   { err.substancePrompt = data.prompt; err.substanceTier = data.substance_tier; }
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
    } else if (err.message === 'missing_substance') {
      showSubstanceWarning(err.substancePrompt || 'Add more detail to generate a stronger post.');
      if (err.substanceTier === 'warn') {
        const bypassBtn = document.createElement('button');
        bypassBtn.id = 'chat-generate-anyway';
        bypassBtn.style.cssText = 'display:block;font-size:0.8125rem;font-weight:600;color:var(--text-muted);' +
          'background:none;border:none;padding:6px 0 0;cursor:pointer;font-family:var(--font-sans);text-align:left;';
        bypassBtn.textContent = 'Generate anyway →';
        bypassBtn.addEventListener('click', () => {
          hideSubstanceWarning();
          triggerGenerate({ skipSubstanceCheck: true });
        });
        chatSubstanceWarn.appendChild(bypassBtn);
      }
    } else {
      showChatError('Something went wrong. <a href="#">Try again →</a>');
    }
  }
}

/* ── Lead magnet generation ──────────────────────────────────── */

/* ── Processing screen ───────────────────────────────────────── */
function extractAngleLabel(rawIdea) {
  const FILLER = /^(so|well|i|we|the|a|an|its|it|this|that|here|just|actually|basically)\b\s*/gi;
  const cleaned  = rawIdea.replace(/\n.*/s, '').trim();
  const stripped = cleaned.replace(FILLER, '').trim();
  const snippet  = stripped.replace(/[,;:!?].*/, '').slice(0, 40).trim();
  return snippet || 'your idea';
}

function showProcessingScreen(rawIdea, postType, streaming = false) {
  guidedChat.classList.add('hidden');
  processingScreen.classList.add('visible');
  if (procPreview) procPreview.style.display = 'none';
  if (procPreviewText) procPreviewText.textContent = '';

  const steps = [
    'Analyzing your idea…',
    'Locking in structure…',
    'Writing in your voice…',
    'Final quality check…',
  ];

  for (let i = 0; i < 4; i++) {
    const el = document.getElementById(`proc-step-${i}`);
    if (!el) continue;
    el.className = 'proc-step';
    el.querySelector('.proc-step-icon').innerHTML = '⏳';
    el.querySelector('.proc-step-text').textContent = steps[i];
  }

  if (streaming) {
    // Real SSE events drive step updates — just show step 0 immediately
    const el0 = document.getElementById('proc-step-0');
    if (el0) {
      el0.classList.add('visible');
      el0.querySelector('.proc-step-icon').innerHTML = '<span class="proc-spinner"></span>';
    }
    return;
  }

  // Fake animation for non-streaming paths (vault)
  const fakeSteps = [
    'Finding the tension…',
    `Angle: ${extractAngleLabel(rawIdea || '')}`,
    'Writing in your voice…',
    'Final quality check…',
  ];
  for (let i = 0; i < 4; i++) {
    const el = document.getElementById(`proc-step-${i}`);
    if (el) el.querySelector('.proc-step-text').textContent = fakeSteps[i];
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
  const arc       = data.stage1Blueprint?.arc || null;
  const step2 = document.getElementById('proc-step-2');
  if (step2) {
    let label;
    if (arc) {
      label = arc.length > 68 ? `${arc.slice(0, 65)}…` : arc;
    } else {
      label = archetype ? `Hook type: ${archetype}` : 'Writing in your voice…';
    }
    step2.querySelector('.proc-step-text').textContent = label;
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
  if (procPreview) procPreview.style.display = 'none';
  if (procPreviewText) procPreviewText.textContent = '';
  checkSpecificityNudge(chatInput.value.trim());
}

/* ── Specificity nudge ───────────────────────────────────────── */
const NICHE_SIGNALS = {
  finance:    /revenue|profit|arr|mrr|valuation|\$|%|quarter|fiscal|roi|irr|cagr|ebitda/i,
  sales:      /pipeline|quota|close rate|deal|prospect|revenue|%|conversion|outreach|signed/i,
  marketing:  /ctr|conversion|roas|cpa|impressions|leads|funnel|campaign|traffic|%/i,
  coaching:   /session|client|transformation|weeks|results|breakthrough|shift|outcome/i,
  recruiting: /hire|candidate|offer|interview|retention|headcount|role|weeks/i,
  product:    /user|retention|churn|feature|release|sprint|roadmap|nps|activation|%/i,
  legal:      /case|settlement|ruling|compliance|contract|risk|statute|judgment/i,
  consulting: /engagement|deliverable|stakeholder|framework|revenue|client|weeks/i,
  leadership: /team|culture|retention|performance|quarters|decision|morale|report/i,
};

function getNicheSignalRegex(niche) {
  if (!niche) return null;
  const lower = niche.toLowerCase();
  for (const [key, rx] of Object.entries(NICHE_SIGNALS)) {
    if (lower.includes(key)) return rx;
  }
  return null;
}

const VAGUE_PHRASES = /\b(things|stuff|approach|better|improved|more|less|different|changed|helped|worked|good|great|best|impact|results|success|growth|strategy|solution|method|process|system|way|manner)\b/gi;

function isLikelyVague(val) {
  const words = val.trim().split(/\s+/).length;
  if (words < 8) return false;
  const vagueMatches = (val.match(VAGUE_PHRASES) || []).length;
  // Vague if more than 30% of words are generic filler with no concrete anchor
  const hasConcreteAnchor = /\b(stopped|fired|hired|quit|sent|called|refused|decided|pivoted|cut|doubled|tripled|lost|won|walked|said|told|asked|built|launched|closed|signed|left|joined)\b/i.test(val)
    || /\d/.test(val)
    || /"[^"]+"/.test(val); // quoted speech is specific
  return vagueMatches >= 3 && !hasConcreteAnchor;
}

function checkSpecificityNudge(val) {
  if (!val || !selectedType) { hideSpecificityNudge(); return; }
  if (val.length < 40) { hideSpecificityNudge(); return; }

  const niche = _nicheProfile?.content_niche || '';

  if (isLikelyVague(val)) {
    const nicheLabel = niche ? `in ${niche}` : 'in your work';
    showSpecificityNudge(`What specifically happened ${nicheLabel}? Name the decision, the moment, or who was involved — that's what makes posts memorable.`);
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
  document.getElementById('chat-generate-anyway')?.remove();
}

/* ── Profile gate + niche placeholder ───────────────────────── */
async function checkProfileGate() {
  try {
    const res  = await fetch('/api/profile', { headers: apiHeaders() });
    const data = await res.json();
    if (!data.ok) return;
    const profile = data.profile || {};
    _nicheProfile = profile;

    const hasNiche = !!profile.content_niche?.trim();
    const hasVoice = !!profile.voice_fingerprint || !!profile.onboarding_q2?.trim();

    if (!hasNiche) {
      showProfileNudge('empty');
    } else if (!hasVoice) {
      showProfileNudge('voice');
    } else {
      loadNichePlaceholder(profile);
    }
  } catch { /* gate fails open */ }
}

function showProfileNudge(tier = 'empty') {
  if (document.getElementById('profile-gate-nudge')) return;
  const nudge = document.createElement('div');
  nudge.id        = 'profile-gate-nudge';
  nudge.className = 'profile-gate-nudge';
  if (tier === 'voice') {
    nudge.innerHTML = '<strong>Your voice hasn\'t been set up yet.</strong> Answer 3 quick questions and every post will sound like you — not generic AI. <a href="/settings.html#voice">Complete voice setup →</a>';
  } else {
    nudge.innerHTML = '<strong>Your voice profile is empty.</strong> Posts will be generic until you tell ScoutHook your niche and audience. <a href="/settings.html#voice">Set it up now →</a>';
  }
  guidedChat.insertAdjacentElement('beforebegin', nudge);
}

function loadNichePlaceholder(profile) {
  if (!profile?.input_examples) return;
  try {
    const examples = JSON.parse(profile.input_examples);
    if (!Array.isArray(examples) || examples.length === 0) return;
    _nichePlaceholders = examples.filter(e => typeof e === 'string' && e.trim());
    applyNichePlaceholder();
  } catch { /* malformed JSON — ignore */ }
}

function applyNichePlaceholder() {
  if (!_nichePlaceholders.length) return;
  if (!selectedType) return;
  const example = _nichePlaceholders[Math.floor(Math.random() * _nichePlaceholders.length)];
  if (!chatInput.value.trim()) chatInput.placeholder = example;
}

/* ── Vault empty-state quality banner ───────────────────────── */
async function checkVaultEmptyState() {
  try {
    const res  = await fetch('/api/vault/documents', { headers: apiHeaders() });
    const data = await res.json();
    if (!data.ok || (data.documents || []).length > 0) return;
    const banner = document.getElementById('vault-quality-banner');
    if (!banner) return;
    banner.innerHTML =
      '<p class="vqb-text">Posts grounded in your real work are far more specific than anything generated from scratch.</p>' +
      '<a class="vqb-cta" href="/vault.html">Upload a case study →</a>';
    banner.style.display = '';
  } catch { /* non-fatal */ }
}

/* ── Init ────────────────────────────────────────────────────── */
(async function init() {
  await window.scouthookAuthReady;

  // Default to reach immediately; loadMixRecommendation may update this
  selectType('reach');

  loadMixRecommendation();    // fire-and-forget — updates active btn if mix recommends a type
  checkProfileGate();         // fire-and-forget — nudge appears if profile is empty

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

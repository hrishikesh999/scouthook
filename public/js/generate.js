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
let _selectedProfileId  = null; // numeric profile id, null = use workspace default
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
let _authorityLengthPreference = 'Medium'; // length choice for Authority/Expertise posts (set via chat)
let _authorityCtaIntent        = '';       // CTA intent for Authority/Expertise posts
let _authorityIdeaBrief        = '';       // stores the user's idea while waiting for length selection
let _storyChatStep          = 0;           // 0=event, 1=shift, 2=details, 3=length
let _storyEvent             = '';
let _storyShift             = '';
let _storySupportingDetails = '';
let _storyLengthPreference  = 'Medium';
let _btsChatStep            = 0;           // 0=topic, 1=turning_point, 2=context, 3=length
let _btsTopic               = '';
let _btsTurningPoint        = '';
let _btsSupportingContext   = '';
let _btsLengthPreference    = 'Medium';
let _contrarianChatStep         = 0;       // 0=belief, 1=pov, 2=reason, 3=length
let _contrarianBelief           = '';
let _contrarianPov              = '';
let _contrarianSupportingReason = '';
let _contrarianLengthPreference = 'Medium';
let _frameworkChatStep         = 0;        // 0=topic, 1=context, 2=length
let _frameworkTopic            = '';
let _frameworkContext          = '';
let _frameworkLengthPreference = 'Medium';
let _announcementChatStep      = 0;        // 0=occasion, 1=length
let _announcementOccasion      = '';
let _announcementLengthPreference = 'Medium';
let _leadGenChatStep         = 0;          // 0=problem, 1=desired_outcome, 2=offer, 3=cta, 4=length
let _leadGenCoreProblem      = '';
let _leadGenDesiredOutcome   = '';
let _leadGenOfferDesc        = '';
let _leadGenCtaText          = '';
let _leadGenLengthPreference = 'Medium';
let _lessonsChatStep          = 0;         // 0=event, 1=obstacle, 2=key_lesson, 3=changed_you, 4=length
let _lessonsEvent             = '';
let _lessonsObstacle          = '';
let _lessonsKeyLesson         = '';
let _lessonsChangedYou        = '';
let _lessonsLengthPreference  = 'Medium';
let _prefetchedIdeas    = null;      // prefetched result from /api/vault/generate-ideas
let _allFreshIdeas      = [];        // all fetched fresh ideas — filters applied client-side
let _lastIcpSummary     = '';        // icp_summary from last fetch
// ── Conversational coach state ────────────────────────────────
let _coach = {
  active:         false,  // coach is running
  originalBrief:  '',     // user's initial textarea input
  history:        [],     // [{role:'user'|'coach', content}]
  exchangeCount:  0,      // completed Q&A rounds
  awaitingSkip:   false,  // showing a skip suggestion for review — blocks normal send
  pendingQ:       null,   // the question the current suggestion belongs to
  intakeInFlight: false,  // prevents double-submit race while callIntake is pending
  seq:            0,      // incremented on every init(); stale .then() callbacks check this
};

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
let voiceCtrl             = null;

/* ── Per-type chat configs ───────────────────────────────────── */
const CHAT_CONFIGS = {
  reach:   { label: '📣 Reach post' },
  trust:   { label: '✏️ Authority/Expertise' },
  story:   { label: '📖 Story/Personal Experience' },
  bts:          { label: '🎬 Behind the Scenes' },
  contrarian:   { label: '🔥 Contrarian / Hot Take' },
  framework:    { label: '📚 Framework / How-To' },
  announcement: { label: '🎉 Announcement' },
  lead_gen:        { label: '🎯 Lead Gen / Offer' },
  lessons_learned: { label: '📝 Lessons Learned' },
  convert:         { label: '💬 Conversation post' },
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
      key:         'teaching',
      question:    'What do you want to teach or clarify?',
      helpText:    'Share the idea, insight, or belief you want to explain. This should be one clear point you want your audience to understand better.',
      placeholder: 'One idea, belief, or insight you understand well — explained clearly for your audience…',
      required:    true,
      minChars:    20,
      errorMsg:    'Share the idea you want to explain — even a rough first draft is enough.',
    },
  ],
  story: [
    {
      key:         'story_event',
      question:    'Describe the real event or moment that happened.',
      helpText:    'Be specific and honest. What happened, what was the situation, what did you go through?',
      placeholder: 'The moment, the situation, the experience — in your own words…',
      required:    true,
      minChars:    40,
      errorMsg:    'Share the event or moment — even a rough draft is enough.',
    },
  ],
  bts: [
    {
      key:         'bts_topic',
      question:    'What are you showing behind the scenes?',
      helpText:    'The core process, moment, workflow, or internal work you\'re revealing. Be specific and real.',
      placeholder: 'e.g. How I restructured our onboarding flow, the decision to cut a feature before launch…',
      required:    true,
      minChars:    20,
      errorMsg:    'Share the process or moment you\'re revealing — even a rough description is enough.',
    },
  ],
  contrarian: [
    {
      key:         'contrarian_belief',
      question:    'What mainstream belief do you want to challenge?',
      helpText:    'The common assumption, myth, or "conventional wisdom" your audience holds — that you\'re about to push back on.',
      placeholder: 'The belief most people in your field accept without question…',
      required:    true,
      minChars:    20,
      errorMsg:    'Share the belief you\'re challenging — even a rough first draft is enough.',
    },
  ],
  framework: [
    {
      key:         'framework_topic',
      question:    'What do you want to teach or explain?',
      helpText:    'The skill, method, or concept you\'re breaking down. Be specific — one clear topic works best.',
      placeholder: 'e.g. How to write a cold email that gets replies, the 3-step process I use to prioritise tasks…',
      required:    true,
      minChars:    20,
      errorMsg:    'Share the topic you want to teach — even a rough first draft is enough.',
    },
  ],
  announcement: [
    {
      key:         'occasion',
      question:    'What\'s the occasion or message?',
      helpText:    'Briefly describe the wish, thank-you, greeting, or appreciation you want to post. Example: \'Thanking our community for 10k followers\' or \'Wishing everyone a happy Christmas\'',
      placeholder: 'e.g. Thanking our community for 10k followers, wishing everyone a happy Diwali…',
      required:    true,
      minChars:    15,
      errorMsg:    'Describe the occasion or message — even a few words are enough.',
    },
  ],
  lead_gen: [
    {
      key:         'core_problem',
      question:    'What problem or pain does your offer solve?',
      helpText:    'The main frustration your audience faces that your product or offer helps with. Be specific and relatable.',
      placeholder: 'e.g. Most coaches charge $5k upfront and never give you real access after the sale…',
      required:    true,
      minChars:    20,
      errorMsg:    'Describe the problem you\'re solving — even a rough first draft is fine.',
    },
  ],
  lessons_learned: [
    {
      key:         'lesson_event',
      question:    'What happened? Describe the event or situation.',
      helpText:    'The project, decision, client situation, or experience that taught you something. Be specific and real.',
      placeholder: 'e.g. I launched a product I was proud of — and nobody bought it. Here\'s what I learned…',
      required:    true,
      minChars:    30,
      errorMsg:    'Describe what happened — even a rough draft is enough.',
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
  document.querySelectorAll('.start-pill[data-prompt]').forEach(p => p.classList.remove('active'));
  const _pq = document.getElementById('pill-question');
  if (_pq) { _pq.textContent = ''; _pq.classList.remove('visible'); }
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

  // Authority/Expertise enters a focused mode: hide the header and pills so the
  // user can concentrate on the two-question chat flow.
  const genHeader    = document.querySelector('.gen-header');
  const startingPills = document.getElementById('starting-pills');
  const pillQ        = document.getElementById('pill-question');
  if (type === 'trust' || type === 'story' || type === 'announcement' || type === 'contrarian' || type === 'framework' || type === 'lead_gen' || type === 'lessons_learned') {
    if (genHeader)     genHeader.style.display     = 'none';
    if (startingPills) startingPills.style.display = 'none';
    if (pillQ)        { pillQ.textContent = ''; pillQ.classList.remove('visible'); }
  } else {
    if (genHeader)     genHeader.style.display     = '';
    if (startingPills) startingPills.style.display = '';
  }

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
  if (reset) { _shownIdeaHooks = []; _currentPostTypeFilter = null; _ideaTab = 'fresh'; _allFreshIdeas = []; _lastIcpSummary = ''; }
  const panel = document.getElementById('vault-panel');
  if (!panel) return;
  panel.style.display = '';

  if (_ideaTab === 'saved') {
    await loadSavedIdeas(panel, onItemSelected);
  } else {
    await loadFreshIdeas(panel, type, onItemSelected);
  }
}

async function prefetchIdeas() {
  try {
    // Always fetch mixed (no post_type) so filters work client-side on a full set
    const params = new URLSearchParams();
    const res  = await fetch(`/api/vault/generate-ideas?${params}`, { headers: apiHeaders() });
    const data = await res.json();
    if (data.ideas?.length) _prefetchedIdeas = data;
  } catch { /* non-fatal */ }
}

async function loadFreshIdeas(panel, type, onItemSelected) {
  renderIdeaLoadingState(panel, 'fresh', onItemSelected);

  try {
    let data;
    if (_prefetchedIdeas && !_shownIdeaHooks.length) {
      data = _prefetchedIdeas;
      _prefetchedIdeas = null;
    } else {
      // Always fetch without post_type — filtering is done client-side
      const params = new URLSearchParams();
      if (_shownIdeaHooks.length) params.set('exclude_hooks', JSON.stringify(_shownIdeaHooks.slice(-12)));
      const res = await fetch(`/api/vault/generate-ideas?${params}`, { headers: apiHeaders() });
      data = await res.json();
    }

    const ideas = data.ideas || [];
    if (!ideas.length && !_allFreshIdeas.length) { panel.style.display = 'none'; panel.innerHTML = ''; return; }

    _shownIdeaHooks.push(...ideas.map(i => i.hook));
    _allFreshIdeas.push(...ideas);
    _lastIcpSummary = data.icp_summary || _lastIcpSummary;

    renderFilteredIdeas(panel, onItemSelected);
  } catch { panel.style.display = 'none'; panel.innerHTML = ''; }
}

function renderFilteredIdeas(panel, onItemSelected) {
  const visible = _currentPostTypeFilter
    ? _allFreshIdeas.filter(idea => idea.post_type === _currentPostTypeFilter)
    : _allFreshIdeas;
  renderIdeaEngine(panel, visible, _lastIcpSummary, 'fresh', onItemSelected);
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

  // Filter chips (fresh tab only) — client-side filter, no API call
  panel.querySelectorAll('.idea-filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      _currentPostTypeFilter = chip.dataset.filter === 'all' ? null : chip.dataset.filter;
      renderFilteredIdeas(panel, onItemSelected);
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

    if (opts.onSkip) {
      const skip = document.createElement('button');
      skip.className = 'coach-skip-btn';
      skip.textContent = 'Suggest an answer →';
      skip.addEventListener('click', () => opts.onSkip());
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

  // Renders a suggestion bubble with an editable textarea for confirm/edit
  function addSuggestion(suggestion, onConfirm) {
    const wrap = document.createElement('div');
    wrap.className = 'coach-suggestion-wrap';

    const label = document.createElement('p');
    label.className = 'coach-suggestion-label';
    label.textContent = 'Here\'s a suggestion based on your profile — edit it to match your experience, then hit confirm:';
    wrap.appendChild(label);

    const ta = document.createElement('textarea');
    ta.className   = 'coach-suggestion-ta';
    ta.value       = suggestion;
    ta.rows        = 3;
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    });
    wrap.appendChild(ta);

    const btn = document.createElement('button');
    btn.className   = 'coach-suggestion-confirm';
    btn.textContent = 'Use this →';
    btn.addEventListener('click', () => {
      const val = ta.value.trim();
      if (!val) return;
      wrap.querySelector('.coach-suggestion-confirm').disabled = true;
      onConfirm(val);
    });
    wrap.appendChild(btn);

    chatThread.appendChild(wrap);
    chatThread.scrollTop = chatThread.scrollHeight;
    ta.focus();
    return wrap;
  }

  // Authority/Expertise step 2: render length-choice bot bubble with label + help text + chips
  function showAuthorityLengthQuestion() {
    const bubble = addQuestionBubble(
      'Post length',
      'Choose how deep you want to go. Short = one sharp idea. Medium = explained clearly. Long = detailed breakdown.'
    );

    const chips = document.createElement('div');
    chips.className = 'authority-length-chips';

    const lengths = [
      { value: 'Short',  label: 'Short',  hint: '≤100 words'   },
      { value: 'Medium', label: 'Medium', hint: '120-250 words' },
      { value: 'Long',   label: 'Long',   hint: '300-500 words' },
    ];

    lengths.forEach(({ value, label, hint }) => {
      const btn = document.createElement('button');
      btn.className = 'length-chip';
      btn.type      = 'button';
      btn.innerHTML = `${label} <span class="length-chip-hint">${hint}</span>`;
      btn.addEventListener('click', () => {
        _authorityLengthPreference = value;
        chips.querySelectorAll('.length-chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        addUser(label);
        triggerGenerate({ enrichedIdea: _authorityIdeaBrief });
      });
      chips.appendChild(btn);
    });

    bubble.appendChild(chips);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  // ── Story / Personal Experience step renderers ──────────────────────────

  function showStoryShiftQuestion() {
    addQuestionBubble(
      'Story Shift / Realization',
      'The key realization, lesson, or perspective change that came from this experience.'
    );
    chatInput.placeholder = 'What clicked, what changed, what did you learn from this…';
    chatInput.focus();
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function showStorySupportingDetailsQuestion() {
    const bubble = addQuestionBubble(
      'Supporting Details',
      'Any additional struggle, emotion, context, or outcome worth mentioning. If left blank, ScoutHook will infer this naturally.'
    );
    const skipBtn = document.createElement('button');
    skipBtn.type      = 'button';
    skipBtn.className = 'story-skip-btn';
    skipBtn.textContent = 'Skip →';
    skipBtn.addEventListener('click', () => {
      _storySupportingDetails = '';
      _storyChatStep = 3;
      addUser('(skipped)');
      chatInput.value       = '';
      chatInput.style.height = '';
      showStoryLengthQuestion();
    });
    bubble.appendChild(skipBtn);
    chatInput.placeholder = 'Any extra context, emotion, or outcome — or skip this step…';
    chatInput.focus();
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function showStoryLengthQuestion() {
    const bubble = addQuestionBubble(
      'Post length',
      'Choose how deep you want to go. Short = one sharp beat. Medium = full arc. Long = detailed breakdown.'
    );
    const chips = document.createElement('div');
    chips.className = 'authority-length-chips';

    [
      { value: 'Short',  label: 'Short',  hint: '8–12 lines'  },
      { value: 'Medium', label: 'Medium', hint: '12–18 lines' },
      { value: 'Long',   label: 'Long',   hint: '18–30 lines' },
    ].forEach(({ value, label, hint }) => {
      const btn = document.createElement('button');
      btn.className = 'length-chip';
      btn.type      = 'button';
      btn.innerHTML = `${label} <span class="length-chip-hint">${hint}</span>`;
      btn.addEventListener('click', () => {
        _storyLengthPreference = value;
        chips.querySelectorAll('.length-chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        addUser(label);
        triggerGenerate({ enrichedIdea: _buildStoryPrompt() });
      });
      chips.appendChild(btn);
    });

    bubble.appendChild(chips);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function _buildStoryPrompt() {
    const parts = [
      `STORY EVENT:\n${_storyEvent}`,
      `STORY SHIFT / REALIZATION:\n${_storyShift}`,
    ];
    if (_storySupportingDetails.trim()) {
      parts.push(`SUPPORTING DETAILS:\n${_storySupportingDetails}`);
    }
    return parts.join('\n\n');
  }

  // ── Lessons Learned step renderers ─────────────────────────────────────────

  function showLessonsObstacleQuestion() {
    const bubble = addQuestionBubble(
      'What Went Wrong / The Obstacle',
      'What made this hard, what broke, what you underestimated. Leave blank if the lesson came without a clear obstacle.'
    );
    const skipBtn = document.createElement('button');
    skipBtn.type        = 'button';
    skipBtn.className   = 'story-skip-btn';
    skipBtn.textContent = 'Skip →';
    skipBtn.addEventListener('click', () => {
      _lessonsObstacle = '';
      _lessonsChatStep = 2;
      addUser('(skipped)');
      chatInput.value        = '';
      chatInput.style.height = '';
      showLessonsKeyLessonQuestion();
    });
    bubble.appendChild(skipBtn);
    chatInput.placeholder = 'What went wrong, what you underestimated, what blocked you — or skip…';
    chatInput.focus();
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function showLessonsKeyLessonQuestion() {
    addQuestionBubble(
      'The Key Lesson',
      'The core insight, belief shift, or realization you took away. One clear, honest lesson.'
    );
    chatInput.placeholder = 'What you now know, believe, or do differently…';
    chatInput.focus();
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function showLessonsChangedYouQuestion() {
    const bubble = addQuestionBubble(
      'How It Changed You / Your Strategy',
      'What shifted in how you work, think, or decide. Leave blank if the post ends at the lesson.'
    );
    const skipBtn = document.createElement('button');
    skipBtn.type        = 'button';
    skipBtn.className   = 'story-skip-btn';
    skipBtn.textContent = 'Skip →';
    skipBtn.addEventListener('click', () => {
      _lessonsChangedYou = '';
      _lessonsChatStep   = 4;
      addUser('(skipped)');
      chatInput.value        = '';
      chatInput.style.height = '';
      showLessonsLengthQuestion();
    });
    bubble.appendChild(skipBtn);
    chatInput.placeholder = 'How you think, work, or decide differently now — or skip…';
    chatInput.focus();
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function showLessonsLengthQuestion() {
    const bubble = addQuestionBubble(
      'Post length',
      'Choose how deep you want to go. Short = one sharp lesson. Medium = full arc. Long = detailed reflection.'
    );
    const chips = document.createElement('div');
    chips.className = 'authority-length-chips';

    [
      { value: 'Short',  label: 'Short',  hint: '8–12 lines'  },
      { value: 'Medium', label: 'Medium', hint: '12–18 lines' },
      { value: 'Long',   label: 'Long',   hint: '18–28 lines' },
    ].forEach(({ value, label, hint }) => {
      const btn = document.createElement('button');
      btn.className = 'length-chip';
      btn.type      = 'button';
      btn.innerHTML = `${label} <span class="length-chip-hint">${hint}</span>`;
      btn.addEventListener('click', () => {
        _lessonsLengthPreference = value;
        chips.querySelectorAll('.length-chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        addUser(label);
        triggerGenerate({ enrichedIdea: _buildLessonsPrompt() });
      });
      chips.appendChild(btn);
    });

    bubble.appendChild(chips);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function _buildLessonsPrompt() {
    const parts = [`LESSON EVENT:\n${_lessonsEvent}`];
    if (_lessonsObstacle.trim())  parts.push(`WHAT WENT WRONG / OBSTACLE:\n${_lessonsObstacle}`);
    parts.push(`KEY LESSON:\n${_lessonsKeyLesson}`);
    if (_lessonsChangedYou.trim()) parts.push(`HOW IT CHANGED YOU / YOUR STRATEGY:\n${_lessonsChangedYou}`);
    return parts.join('\n\n');
  }

  // ── Behind the Scenes step renderers ───────────────────────────────────────

  function showBtsTurningPointQuestion() {
    addQuestionBubble(
      'The Turning Point',
      'What shifted during the process? A decision you made, an assumption that broke, or something you had to change mid-way.'
    );
    chatInput.placeholder = 'What changed, what broke, what you had to reconsider…';
    chatInput.focus();
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function showBtsSupportingContextQuestion() {
    const bubble = addQuestionBubble(
      'Supporting Context',
      'Any extra context, challenge, or messy detail worth sharing. If left blank, ScoutHook will infer this naturally.'
    );
    const skipBtn = document.createElement('button');
    skipBtn.type      = 'button';
    skipBtn.className = 'story-skip-btn';
    skipBtn.textContent = 'Skip →';
    skipBtn.addEventListener('click', () => {
      _btsSupportingContext = '';
      _btsChatStep = 3;
      addUser('(skipped)');
      chatInput.value       = '';
      chatInput.style.height = '';
      showBtsLengthQuestion();
    });
    bubble.appendChild(skipBtn);
    chatInput.placeholder = 'Any extra context, constraint, or hiccup — or skip this step…';
    chatInput.focus();
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function showBtsLengthQuestion() {
    const bubble = addQuestionBubble(
      'Post length',
      'Choose how deep you want to go. Short = one sharp observation. Medium = process breakdown. Long = detailed walkthrough.'
    );
    const chips = document.createElement('div');
    chips.className = 'authority-length-chips';

    [
      { value: 'Short',  label: 'Short',  hint: '≤100 words'   },
      { value: 'Medium', label: 'Medium', hint: '120-250 words' },
      { value: 'Long',   label: 'Long',   hint: '300-500 words' },
    ].forEach(({ value, label, hint }) => {
      const btn = document.createElement('button');
      btn.className = 'length-chip';
      btn.type      = 'button';
      btn.innerHTML = `${label} <span class="length-chip-hint">${hint}</span>`;
      btn.addEventListener('click', () => {
        _btsLengthPreference = value;
        chips.querySelectorAll('.length-chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        addUser(label);
        triggerGenerate({ enrichedIdea: _buildBtsPrompt() });
      });
      chips.appendChild(btn);
    });

    bubble.appendChild(chips);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function _buildBtsPrompt() {
    const parts = [
      `BTS TOPIC:\n${_btsTopic}`,
      `THE TURNING POINT:\n${_btsTurningPoint}`,
    ];
    if (_btsSupportingContext.trim()) {
      parts.push(`SUPPORTING CONTEXT:\n${_btsSupportingContext}`);
    }
    return parts.join('\n\n');
  }

  // ── Contrarian / Hot Take step renderers ──────────────────────────────────

  function showContrarianPovQuestion() {
    addQuestionBubble(
      'Your POV / Hot Take',
      'Your contrarian opinion or counter-belief. This is the core of the hot take — state it confidently.'
    );
    chatInput.placeholder = 'Your bold counter-belief or hot take…';
    chatInput.focus();
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function showContrarianSupportingReasonQuestion() {
    const bubble = addQuestionBubble(
      'Supporting Reason',
      'Additional logic, observation, or experience that backs your POV. If left blank, ScoutHook will infer a strong reason from your brand and audience context.'
    );
    const skipBtn = document.createElement('button');
    skipBtn.type      = 'button';
    skipBtn.className = 'story-skip-btn';
    skipBtn.textContent = 'Skip →';
    skipBtn.addEventListener('click', () => {
      _contrarianSupportingReason = '';
      _contrarianChatStep = 3;
      addUser('(skipped)');
      chatInput.value       = '';
      chatInput.style.height = '';
      showContrarianLengthQuestion();
    });
    bubble.appendChild(skipBtn);
    chatInput.placeholder = 'The logic, data, or experience that supports your view — or skip…';
    chatInput.focus();
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function showContrarianLengthQuestion() {
    const bubble = addQuestionBubble(
      'Post length',
      'Short = a sharp, punchy take. Medium = belief + reasoning. Long = full breakdown with implication.'
    );
    const chips = document.createElement('div');
    chips.className = 'authority-length-chips';

    [
      { value: 'Short',  label: 'Short',  hint: '6–10 lines'  },
      { value: 'Medium', label: 'Medium', hint: '10–15 lines' },
      { value: 'Long',   label: 'Long',   hint: '15–25 lines' },
    ].forEach(({ value, label, hint }) => {
      const btn = document.createElement('button');
      btn.className = 'length-chip';
      btn.type      = 'button';
      btn.innerHTML = `${label} <span class="length-chip-hint">${hint}</span>`;
      btn.addEventListener('click', () => {
        _contrarianLengthPreference = value;
        chips.querySelectorAll('.length-chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        addUser(label);
        triggerGenerate({ enrichedIdea: _buildContrarianPrompt() });
      });
      chips.appendChild(btn);
    });

    bubble.appendChild(chips);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function _buildContrarianPrompt() {
    const parts = [
      `MAINSTREAM BELIEF TO CHALLENGE:\n${_contrarianBelief}`,
      `YOUR POV / HOT TAKE:\n${_contrarianPov}`,
    ];
    if (_contrarianSupportingReason.trim()) {
      parts.push(`SUPPORTING REASON:\n${_contrarianSupportingReason}`);
    }
    return parts.join('\n\n');
  }

  // ── Framework / How-To step renderers ────────────────────────────────────

  function showFrameworkContextQuestion() {
    const bubble = addQuestionBubble(
      'Core Context or Hints (Optional)',
      'Any context, examples, or hints about why this matters or how the framework should be structured. If you skip, ScoutHook will infer a clear framework automatically.'
    );
    const skipBtn = document.createElement('button');
    skipBtn.type      = 'button';
    skipBtn.className = 'story-skip-btn';
    skipBtn.textContent = 'Skip →';
    skipBtn.addEventListener('click', () => {
      _frameworkContext  = '';
      _frameworkChatStep = 2;
      addUser('(skipped)');
      chatInput.value       = '';
      chatInput.style.height = '';
      showFrameworkLengthQuestion();
    });
    bubble.appendChild(skipBtn);
    chatInput.placeholder = 'Context, key steps, or why this matters — or skip and let ScoutHook decide…';
    chatInput.focus();
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function showFrameworkLengthQuestion() {
    const bubble = addQuestionBubble(
      'Post length',
      'Short = tight punchy lesson. Medium = full framework with steps. Long = detailed breakdown with examples.'
    );
    const chips = document.createElement('div');
    chips.className = 'authority-length-chips';

    [
      { value: 'Short',  label: 'Short',  hint: '6–10 lines'  },
      { value: 'Medium', label: 'Medium', hint: '10–15 lines' },
      { value: 'Long',   label: 'Long',   hint: '15–25 lines' },
    ].forEach(({ value, label, hint }) => {
      const btn = document.createElement('button');
      btn.className = 'length-chip';
      btn.type      = 'button';
      btn.innerHTML = `${label} <span class="length-chip-hint">${hint}</span>`;
      btn.addEventListener('click', () => {
        _frameworkLengthPreference = value;
        chips.querySelectorAll('.length-chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        addUser(label);
        triggerGenerate({ enrichedIdea: _buildFrameworkPrompt() });
      });
      chips.appendChild(btn);
    });

    bubble.appendChild(chips);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function _buildFrameworkPrompt() {
    const parts = [`TOPIC OR SKILL TO TEACH:\n${_frameworkTopic}`];
    if (_frameworkContext.trim()) {
      parts.push(`CORE CONTEXT / HINTS:\n${_frameworkContext}`);
    }
    return parts.join('\n\n');
  }

  function showAnnouncementLengthQuestion() {
    const bubble = addQuestionBubble(
      'Post length',
      'Short for a quick warm note, Medium for a fuller message.'
    );
    const chips = document.createElement('div');
    chips.className = 'authority-length-chips';

    [
      { value: 'Short',  label: 'Short',  hint: '≤100 words'   },
      { value: 'Medium', label: 'Medium', hint: '60–120 words'  },
      { value: 'Long',   label: 'Long',   hint: '150–200 words' },
    ].forEach(({ value, label, hint }) => {
      const btn = document.createElement('button');
      btn.className = 'length-chip';
      btn.type      = 'button';
      btn.innerHTML = `${label} <span class="length-chip-hint">${hint}</span>`;
      btn.addEventListener('click', () => {
        _announcementLengthPreference = value;
        chips.querySelectorAll('.length-chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        addUser(label);
        triggerGenerate({ enrichedIdea: _buildAnnouncementPrompt() });
      });
      chips.appendChild(btn);
    });

    bubble.appendChild(chips);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function _buildAnnouncementPrompt() {
    return `Occasion / Message:\n${_announcementOccasion}`;
  }

  // ── Lead Gen / Offer step renderers ──────────────────────────────────────

  function showLeadGenDesiredOutcomeQuestion() {
    const bubble = addQuestionBubble(
      'Desired Outcome',
      'What does your audience want to achieve or feel after using your offer? If left blank, ScoutHook will infer it from your brand and audience context.'
    );
    const skipBtn = document.createElement('button');
    skipBtn.type      = 'button';
    skipBtn.className = 'story-skip-btn';
    skipBtn.textContent = 'Skip →';
    skipBtn.addEventListener('click', () => {
      _leadGenDesiredOutcome = '';
      _leadGenChatStep = 2;
      addUser('(skipped)');
      chatInput.value       = '';
      chatInput.style.height = '';
      showLeadGenOfferDescQuestion();
    });
    bubble.appendChild(skipBtn);
    chatInput.placeholder = 'e.g. They want to land their first $5k month without burning out…';
    chatInput.focus();
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function showLeadGenOfferDescQuestion() {
    addQuestionBubble(
      'Offer Description',
      'Describe the product, service, or lead magnet you\'re promoting. The more detail you give, the more specific and compelling the soft invite will be.'
    );
    chatInput.placeholder = 'e.g. A 6-week group coaching programme for freelancers who want to hit $10k/month…';
    chatInput.focus();
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function showLeadGenCtaTextQuestion() {
    const bubble = addQuestionBubble(
      'CTA Text',
      'How would you like people to respond? If left blank, ScoutHook will write a natural soft CTA that fits the post.'
    );
    const skipBtn = document.createElement('button');
    skipBtn.type      = 'button';
    skipBtn.className = 'story-skip-btn';
    skipBtn.textContent = 'Skip →';
    skipBtn.addEventListener('click', () => {
      _leadGenCtaText = '';
      _leadGenChatStep = 4;
      addUser('(skipped)');
      chatInput.value       = '';
      chatInput.style.height = '';
      showLeadGenLengthQuestion();
    });
    bubble.appendChild(skipBtn);
    chatInput.placeholder = 'e.g. Type OFFER in the comments, DM me the word READY…';
    chatInput.focus();
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function showLeadGenLengthQuestion() {
    const bubble = addQuestionBubble(
      'Post length',
      'Short = hook + pain + one insight + soft invite. Medium = full structure. Long = fuller treatment with desire arc.'
    );
    const chips = document.createElement('div');
    chips.className = 'authority-length-chips';

    [
      { value: 'Short',  label: 'Short',  hint: '6–10 lines'  },
      { value: 'Medium', label: 'Medium', hint: '10–15 lines' },
      { value: 'Long',   label: 'Long',   hint: '15–22 lines' },
    ].forEach(({ value, label, hint }) => {
      const btn = document.createElement('button');
      btn.className = 'length-chip';
      btn.type      = 'button';
      btn.innerHTML = `${label} <span class="length-chip-hint">${hint}</span>`;
      btn.addEventListener('click', () => {
        _leadGenLengthPreference = value;
        chips.querySelectorAll('.length-chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        addUser(label);
        triggerGenerate({ enrichedIdea: _buildLeadGenPrompt() });
      });
      chips.appendChild(btn);
    });

    bubble.appendChild(chips);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function _buildLeadGenPrompt() {
    const parts = [`CORE PROBLEM OR PAIN:\n${_leadGenCoreProblem}`];
    if (_leadGenDesiredOutcome.trim()) {
      parts.push(`DESIRED OUTCOME:\n${_leadGenDesiredOutcome}`);
    }
    parts.push(`OFFER DESCRIPTION:\n${_leadGenOfferDesc}`);
    if (_leadGenCtaText.trim()) {
      parts.push(`CTA TEXT:\n${_leadGenCtaText}`);
    }
    return parts.join('\n\n');
  }

  const ARROW_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;

  function updateSendBtn() {
    const micBtn = document.getElementById('mic-btn');
    if (_coach.active) {
      chatSendBtn.innerHTML = _coach.exchangeCount >= 2 ? 'Write my post →' : 'Next →';
      chatSendBtn.classList.add('text-mode');
      chatSendBtn.setAttribute('aria-label', _coach.exchangeCount >= 2 ? 'Generate post' : 'Next question');
      if (micBtn) micBtn.classList.add('coach-mode');
    } else {
      chatSendBtn.innerHTML = ARROW_SVG;
      chatSendBtn.classList.remove('text-mode');
      chatSendBtn.setAttribute('aria-label', 'Generate post');
      if (micBtn) micBtn.classList.remove('coach-mode');
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
    const prevType = _type;
    _type          = type;
    _tensionResult = null;
    selectedVaultIdeaId    = null;
    _authorityIdeaBrief    = '';
    _authorityLengthPreference = 'Medium';
    _authorityCtaIntent    = '';
    _storyChatStep          = 0;
    _storyEvent             = '';
    _storyShift             = '';
    _storySupportingDetails = '';
    _storyLengthPreference  = 'Medium';
    _btsChatStep            = 0;
    _btsTopic               = '';
    _btsTurningPoint        = '';
    _btsSupportingContext   = '';
    _btsLengthPreference    = 'Medium';
    _contrarianChatStep         = 0;
    _contrarianBelief           = '';
    _contrarianPov              = '';
    _contrarianSupportingReason = '';
    _contrarianLengthPreference = 'Medium';
    _frameworkChatStep         = 0;
    _frameworkTopic            = '';
    _frameworkContext          = '';
    _frameworkLengthPreference = 'Medium';
    _announcementChatStep      = 0;
    _announcementOccasion      = '';
    _announcementLengthPreference = 'Medium';
    _leadGenChatStep         = 0;
    _leadGenCoreProblem      = '';
    _leadGenDesiredOutcome   = '';
    _leadGenOfferDesc        = '';
    _leadGenCtaText          = '';
    _leadGenLengthPreference = 'Medium';
    _lessonsChatStep          = 0;
    _lessonsEvent             = '';
    _lessonsObstacle          = '';
    _lessonsKeyLesson         = '';
    _lessonsChangedYou        = '';
    _lessonsLengthPreference  = 'Medium';
    _coach = { active: false, originalBrief: '', history: [], exchangeCount: 0, awaitingSkip: false, pendingQ: null, intakeInFlight: false, seq: (_coach.seq ?? 0) + 1 };

    chatThread.innerHTML = '';
    const q0 = EXTRACTION_QUESTIONS[type][0];

    if (type === 'trust' || type === 'story' || type === 'bts' || type === 'contrarian' || type === 'announcement' || type === 'framework' || type === 'lead_gen' || type === 'lessons_learned') {
      // Show the first question immediately as a labelled bot bubble so the user
      // can focus on answering — no pills, no header, just the question.
      chatThread.style.display = '';
      addQuestionBubble(q0.question, q0.helpText);
      chatInput.placeholder    = q0.placeholder;
    } else {
      chatThread.style.display = 'none';
      chatInput.placeholder    = q0.placeholder;
    }

    chatInput.rows             = 4;
    chatInput.style.minHeight  = '100px';
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

  // Renders a labelled question bubble (label + optional help text) as a bot message.
  function addQuestionBubble(label, helpText) {
    const div = document.createElement('div');
    div.className = 'chat-bubble-bot';

    const labelEl = document.createElement('div');
    labelEl.className   = 'chat-bubble-main chat-q-label';
    labelEl.textContent = label;
    div.appendChild(labelEl);

    if (helpText) {
      const helpEl = document.createElement('p');
      helpEl.className   = 'chat-q-help';
      helpEl.textContent = helpText;
      div.appendChild(helpEl);
    }

    chatThread.appendChild(div);
    chatThread.scrollTop = chatThread.scrollHeight;
    return div;
  }

  function advance() {
    hideChatError();
    hideSubstanceWarning();

    // Block normal send while a skip suggestion is awaiting user review
    if (_coach.awaitingSkip) return;

    // Block double-submit while an intake call is already in flight
    if (_coach.intakeInFlight) return;

    const val = chatInput.value.trim();
    if (!val) { showChatInputError('Add something before generating.'); chatInput.focus(); return; }
    if (val.length < 15) { showChatInputError('Add a bit more to work with.'); chatInput.focus(); return; }

    // Coach is active — user is answering a question
    if (_coach.active) {
      addUser(val);
      chatInput.value       = '';
      chatInput.style.height = '';
      _coach.history.push({ role: 'user', content: val });
      _coach.exchangeCount++;
      runCoach();
      return;
    }

    // Not in coach yet — this is the initial brief submission

    // Authority/Expertise: two-step chat flow.
    // Step 1 — user submits their idea; show the length question as a bot bubble.
    if (selectedType === 'trust') {
      _authorityIdeaBrief = val;
      addUser(val);
      chatThread.style.display = '';
      chatInput.value       = '';
      chatInput.style.height = '';
      showAuthorityLengthQuestion();
      return;
    }

    // Story / Personal Experience: four-step chat flow.
    if (selectedType === 'story') {
      if (_storyChatStep === 0) {
        _storyEvent = val;
        _storyChatStep = 1;
        addUser(val);
        chatThread.style.display = '';
        chatInput.value       = '';
        chatInput.style.height = '';
        showStoryShiftQuestion();
      } else if (_storyChatStep === 1) {
        _storyShift = val;
        _storyChatStep = 2;
        addUser(val);
        chatInput.value       = '';
        chatInput.style.height = '';
        showStorySupportingDetailsQuestion();
      } else if (_storyChatStep === 2) {
        _storySupportingDetails = val;
        _storyChatStep = 3;
        addUser(val);
        chatInput.value       = '';
        chatInput.style.height = '';
        showStoryLengthQuestion();
      }
      return;
    }

    // Announcement: two-step chat flow.
    if (selectedType === 'announcement') {
      if (_announcementChatStep === 0) {
        _announcementOccasion = val;
        _announcementChatStep = 1;
        addUser(val);
        chatThread.style.display = '';
        chatInput.value       = '';
        chatInput.style.height = '';
        showAnnouncementLengthQuestion();
      }
      return;
    }

    // Behind the Scenes: four-step chat flow.
    if (selectedType === 'bts') {
      if (_btsChatStep === 0) {
        _btsTopic = val;
        _btsChatStep = 1;
        addUser(val);
        chatThread.style.display = '';
        chatInput.value       = '';
        chatInput.style.height = '';
        showBtsTurningPointQuestion();
      } else if (_btsChatStep === 1) {
        _btsTurningPoint = val;
        _btsChatStep = 2;
        addUser(val);
        chatInput.value       = '';
        chatInput.style.height = '';
        showBtsSupportingContextQuestion();
      } else if (_btsChatStep === 2) {
        _btsSupportingContext = val;
        _btsChatStep = 3;
        addUser(val);
        chatInput.value       = '';
        chatInput.style.height = '';
        showBtsLengthQuestion();
      }
      return;
    }

    // Contrarian / Hot Take: three-step chat flow + length.
    if (selectedType === 'contrarian') {
      if (_contrarianChatStep === 0) {
        _contrarianBelief = val;
        _contrarianChatStep = 1;
        addUser(val);
        chatThread.style.display = '';
        chatInput.value       = '';
        chatInput.style.height = '';
        showContrarianPovQuestion();
      } else if (_contrarianChatStep === 1) {
        _contrarianPov = val;
        _contrarianChatStep = 2;
        addUser(val);
        chatInput.value       = '';
        chatInput.style.height = '';
        showContrarianSupportingReasonQuestion();
      } else if (_contrarianChatStep === 2) {
        _contrarianSupportingReason = val;
        _contrarianChatStep = 3;
        addUser(val);
        chatInput.value       = '';
        chatInput.style.height = '';
        showContrarianLengthQuestion();
      }
      return;
    }

    // Framework / How-To: two-step chat flow + length.
    if (selectedType === 'framework') {
      if (_frameworkChatStep === 0) {
        _frameworkTopic    = val;
        _frameworkChatStep = 1;
        addUser(val);
        chatThread.style.display = '';
        chatInput.value       = '';
        chatInput.style.height = '';
        showFrameworkContextQuestion();
      } else if (_frameworkChatStep === 1) {
        _frameworkContext  = val;
        _frameworkChatStep = 2;
        addUser(val);
        chatInput.value       = '';
        chatInput.style.height = '';
        showFrameworkLengthQuestion();
      }
      return;
    }

    // Lead Gen / Offer: five-step chat flow.
    if (selectedType === 'lead_gen') {
      if (_leadGenChatStep === 0) {
        _leadGenCoreProblem = val;
        _leadGenChatStep = 1;
        addUser(val);
        chatThread.style.display = '';
        chatInput.value       = '';
        chatInput.style.height = '';
        showLeadGenDesiredOutcomeQuestion();
      } else if (_leadGenChatStep === 1) {
        _leadGenDesiredOutcome = val;
        _leadGenChatStep = 2;
        addUser(val);
        chatInput.value       = '';
        chatInput.style.height = '';
        showLeadGenOfferDescQuestion();
      } else if (_leadGenChatStep === 2) {
        _leadGenOfferDesc = val;
        _leadGenChatStep = 3;
        addUser(val);
        chatInput.value       = '';
        chatInput.style.height = '';
        showLeadGenCtaTextQuestion();
      } else if (_leadGenChatStep === 3) {
        _leadGenCtaText = val;
        _leadGenChatStep = 4;
        addUser(val);
        chatInput.value       = '';
        chatInput.style.height = '';
        showLeadGenLengthQuestion();
      }
      return;
    }

    // Lessons Learned: four-step chat flow + length.
    if (selectedType === 'lessons_learned') {
      if (_lessonsChatStep === 0) {
        _lessonsEvent = val;
        _lessonsChatStep = 1;
        addUser(val);
        chatThread.style.display = '';
        chatInput.value       = '';
        chatInput.style.height = '';
        showLessonsObstacleQuestion();
      } else if (_lessonsChatStep === 1) {
        _lessonsObstacle = val;
        _lessonsChatStep = 2;
        addUser(val);
        chatInput.value       = '';
        chatInput.style.height = '';
        showLessonsKeyLessonQuestion();
      } else if (_lessonsChatStep === 2) {
        _lessonsKeyLesson = val;
        _lessonsChatStep = 3;
        addUser(val);
        chatInput.value       = '';
        chatInput.style.height = '';
        showLessonsChangedYouQuestion();
      } else if (_lessonsChatStep === 3) {
        _lessonsChangedYou = val;
        _lessonsChatStep = 4;
        addUser(val);
        chatInput.value       = '';
        chatInput.style.height = '';
        showLessonsLengthQuestion();
      }
      return;
    }

    // Show it in the chat thread and call intake
    _coach.originalBrief = val;
    addUser(val);
    chatThread.style.display = '';
    chatInput.value       = '';
    chatInput.style.height = '';
    chatInput.rows        = 2;
    chatInput.style.minHeight = '60px';

    // Snapshot sequence — if the user switches intent cards before this resolves,
    // seq will have been bumped and we'll discard this stale result
    const capturedSeq = _coach.seq;

    // Skip intake entirely when the brief is already detailed — saves a Haiku round trip
    if (isBriefRich(val)) {
      triggerGenerate({ enrichedIdea: val });
      return;
    }

    // Show a thinking bubble while intake runs
    const thinkingBubble = addBot('Reading your idea…');
    _coach.intakeInFlight = true;
    callIntake(val, [], 0).then(intake => {
      _coach.intakeInFlight = false;
      thinkingBubble.remove();

      // Stale response — user switched type mid-flight; discard
      if (_coach.seq !== capturedSeq) return;

      if (intake.ready) {
        // Brief is already strong — generate straight away
        triggerGenerate({ enrichedIdea: val });
        return;
      }
      // Start the coach
      _coach.active = true;
      _coach.history.push({ role: 'user', content: val });
      _coach.history.push({ role: 'coach', content: intake.question });
      updateSendBtn();
      const qNum = `${_coach.exchangeCount + 1} of up to 3 — `;
      addBot(qNum + intake.question, {
        onSkip: () => showSkipSuggestion(intake.skip_suggestion, intake.question),
      });
      chatInput.focus();
    });
  }

  // Called after each user answer to get the next question (or decide to generate)
  async function runCoach() {
    const capturedSeq = _coach.seq;

    // Show typing indicator
    const thinkingBubble = addBot('…');
    _coach.intakeInFlight = true;
    const intake = await callIntake(
      _coach.originalBrief,
      _coach.history,
      _coach.exchangeCount
    );
    _coach.intakeInFlight = false;
    thinkingBubble.remove();

    // Stale — user switched type mid-flight
    if (_coach.seq !== capturedSeq) return;

    if (intake.ready || _coach.exchangeCount >= 3) {
      generateFromCoach();
      return;
    }

    // Push new question to history so the server has full context next round
    _coach.history.push({ role: 'coach', content: intake.question });

    updateSendBtn();
    const qNum = `${_coach.exchangeCount + 1} of up to 3 — `;
    addBot(qNum + intake.question, {
      onSkip: () => showSkipSuggestion(intake.skip_suggestion, intake.question),
    });
    chatInput.focus();
  }

  function showSkipSuggestion(suggestion, question) {
    if (!suggestion) {
      // No suggestion available — just generate with what we have
      generateFromCoach();
      return;
    }
    _coach.awaitingSkip = true;
    _coach.pendingQ     = question;
    addSuggestion(suggestion, (confirmed) => {
      _coach.awaitingSkip  = false;
      _coach.pendingQ      = null;
      _coach.intakeInFlight = false; // reset in case a previous fetch never cleared it
      _coach.history.push({ role: 'user', content: confirmed });
      _coach.exchangeCount++;
      addUser(confirmed);
      runCoach();
    });
  }

  function generateFromCoach() {
    // Assemble enriched brief: original idea + each coach Q paired with the user's answer
    let enriched = _coach.originalBrief;
    const qa = [];
    for (let i = 0; i < _coach.history.length - 1; i++) {
      if (_coach.history[i].role === 'coach' && _coach.history[i + 1]?.role === 'user') {
        qa.push(`Q: ${_coach.history[i].content}\nA: ${_coach.history[i + 1].content}`);
        i++; // skip the user turn we just consumed
      }
    }
    if (qa.length) {
      enriched += '\n\nAdditional context from our conversation:\n' + qa.join('\n\n');
    }
    updateSendBtn(); // ensures button shows correct state before processing screen takes over
    triggerGenerate({ enrichedIdea: enriched, skipSubstanceCheck: true });
  }

  function isBriefRich(text) {
    if (text.trim().length < 280) return false;
    // Must also contain at least one concrete signal: a digit, or first-person + specific time/result
    return /\d/.test(text) || /\b(last|this|past|next)\s+(week|month|year|quarter)\b/i.test(text);
  }

  async function callIntake(brief, history, exchangeCount) {
    try {
      const res  = await fetch('/api/generate/chat-intake', {
        method:  'POST',
        headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify({ brief, history, post_type: _type, exchange_count: exchangeCount }),
      });
      const data = await res.json();
      return data.ok ? data : { ready: true };
    } catch {
      return { ready: true };
    }
  }

  return { init, advance, fireTensionExtraction };
})();

/* ── Starting point pills ───────────────────────────────────── */
const pillQuestion = document.getElementById('pill-question');
document.querySelectorAll('.start-pill[data-prompt]').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.start-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    pillQuestion.textContent = pill.dataset.prompt;
    pillQuestion.classList.add('visible');
    // Close the Get ideas panel if open
    const vaultPanel = document.getElementById('vault-panel');
    if (vaultPanel) vaultPanel.style.display = 'none';
    chatInput.focus();
  });
});

// Post-type pills (e.g. Authority/Expertise) — select type on click
document.querySelectorAll('.start-pill[data-type]').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.start-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    const pillQ = document.getElementById('pill-question');
    if (pillQ) { pillQ.textContent = ''; pillQ.classList.remove('visible'); }
    const vaultPanel = document.getElementById('vault-panel');
    if (vaultPanel) vaultPanel.style.display = 'none';
    selectType(pill.dataset.type);
  });
});

/* ── Chat input wiring ───────────────────────────────────────── */
chatSendBtn.addEventListener('click', () => { voiceCtrl?.stop(); chat.advance(); });

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
  if (_coach.active) {
    // Coach answer: Enter submits (single-line answers expected)
    if (!e.shiftKey) { e.preventDefault(); voiceCtrl?.stop(); chat.advance(); }
    return;
  }
  if (selectedType) {
    // Initial brief: always multiline — only Cmd/Ctrl+Enter submits
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); voiceCtrl?.stop(); chat.advance(); }
  }
});


/* ── Voice input ─────────────────────────────────────────────── */
voiceCtrl = initVoiceInput({
  input: chatInput,
  btn:   document.getElementById('mic-btn'),
});

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
    if (_selectedProfileId)                             body.profileId            = _selectedProfileId;
    if (tensionStmt)                                    body.tension_statement    = tensionStmt;
    if (selectedVaultIdeaId)                            body.vault_idea_id        = selectedVaultIdeaId;
    if (opts.enrichedIdea || opts.skipSubstanceCheck)   body.skip_substance_check = true;
    if (shouldStream)                                   body.streaming            = true;
    // Authority/Expertise-specific params
    if (selectedType === 'trust') {
      body.length_preference = _authorityLengthPreference || 'Medium';
      body.cta_intent        = _authorityCtaIntent || '';
    }
    // Story/Personal Experience-specific params
    if (selectedType === 'story') {
      body.length_preference = _storyLengthPreference || 'Medium';
      body.cta_intent        = '';
    }
    // Behind-the-Scenes-specific params
    if (selectedType === 'bts') {
      body.length_preference = _btsLengthPreference || 'Medium';
      body.cta_intent        = '';
    }
    // Contrarian / Hot Take-specific params
    if (selectedType === 'contrarian') {
      body.length_preference = _contrarianLengthPreference || 'Medium';
    }
    // Framework / How-To-specific params
    if (selectedType === 'framework') {
      body.length_preference = _frameworkLengthPreference || 'Medium';
    }
    // Announcement-specific params
    if (selectedType === 'announcement') {
      body.length_preference = _announcementLengthPreference || 'Medium';
    }
    // Lead Gen / Offer-specific params
    if (selectedType === 'lead_gen') {
      body.length_preference = _leadGenLengthPreference || 'Medium';
    }

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
        if (sseError.error === 'plan_limit_exceeded' || sseError.error === 'monthly_quota_reached') {
          err.planCurrent = sseError.current ?? sseError.used; err.planLimit = sseError.limit;
        }
        throw err;
      }

      if (!sseResult?.post_id) throw new Error('stream_incomplete');

      await sleep(600);
      sessionStorage.setItem('sh_from_gen', '1');
      window.location.href = `/editor/${encodeURIComponent(sseResult.post_id)}`;
      return;
    }

    // ── Non-streaming fallback (vault, or SSE unavailable) ─────────────────
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const err = new Error(data.error || 'generation_failed');
      if (data.error === 'plan_limit_exceeded' || data.error === 'monthly_quota_reached') {
        err.planCurrent = data.current ?? data.used; err.planLimit = data.limit;
      }
      if (data.error === 'missing_substance')   { err.substancePrompt = data.prompt; err.substanceTier = data.substance_tier; }
      throw err;
    }

    finaliseProcessingSteps(data);
    await sleep(600);
    sessionStorage.setItem('sh_from_gen', '1');
    window.location.href = `/editor/${encodeURIComponent(data.id)}`;

  } catch (err) {
    clearTimeout(timeoutId);
    hideProcessingScreen();

    if (err.name === 'AbortError') {
      showChatError('This is taking longer than expected. <a href="#">Try again →</a>');
    } else if (err.message === 'complete_profile_first') {
      showChatError('Your voice profile is incomplete — posts need it to generate. <a href="/settings.html">Complete it →</a>');
    } else if (err.message === 'plan_limit_exceeded' || err.message === 'monthly_quota_reached') {
      const used = (err.planCurrent != null && err.planLimit != null)
        ? ` You've used ${err.planCurrent} of ${err.planLimit} this month.` : '';
      showChatError(`You've reached your monthly post limit.${used} <a href="#" class="js-upgrade-cta" data-feature="generate">Upgrade →</a>`);
    } else if (err.message === 'rate_limit_exceeded') {
      showChatError("You've hit the hourly generation limit. Wait a few minutes and try again.");
    } else if (err.message === 'high_demand') {
      showChatError('ScoutHook is under high demand right now. Wait 30 seconds and try again.');
    } else if (err.message === 'anthropic_api_key not configured') {
      showChatError('AI service is not configured. Set ANTHROPIC_API_KEY in the admin settings.');
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
    if (window.PricingModal) {
      e.preventDefault();
      const feature = e.currentTarget.dataset.feature || null;
      window.PricingModal.open(feature ? { feature } : {});
    }
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

/* ── Profile selector ───────────────────────────────────────── */
async function loadProfileSelector() {
  try {
    const res  = await fetch('/api/workspaces/profiles', { headers: apiHeaders() });
    const data = await res.json();
    if (!data.ok || !data.profiles?.length) return;

    // Only show the selector when there is at least one personal (LinkedIn) profile —
    // that's the first moment the user has a real choice of whose voice to write in.
    const hasPersonal = data.profiles.some(p => p.profile_type === 'person');
    if (!hasPersonal) return;

    const selector = document.getElementById('profile-selector');
    const btnsEl   = document.getElementById('profile-sel-btns');
    if (!selector || !btnsEl) return;

    const defaultProfile = data.profiles.find(p => p.is_default) || data.profiles[0];
    _selectedProfileId   = defaultProfile.id;

    function renderBtn(p) {
      const initial  = (p.display_name || '?')[0].toUpperCase();
      const avatar   = p.avatar_url
        ? `<img class="profile-sel-avatar" src="${escapeHtml(p.avatar_url)}" alt="">`
        : `<span class="profile-sel-initial">${escapeHtml(initial)}</span>`;
      const typeText = p.profile_type === 'brand' ? 'Brand' : 'LinkedIn';
      const pct      = p.voice_profile_completion_pct || 0;
      const meta     = `<span class="profile-sel-meta">${typeText} · ${pct}%</span>`;
      return `<button class="profile-sel-btn${p.id === _selectedProfileId ? ' active' : ''}"
        type="button" data-profile-id="${p.id}">${avatar}<span class="profile-sel-name">${escapeHtml(p.display_name)}</span>${meta}</button>`;
    }

    btnsEl.innerHTML = data.profiles.map(renderBtn).join('');

    const nudgeEl = document.getElementById('profile-voice-nudge');

    function updateVoiceNudge(profileId) {
      if (!nudgeEl) return;
      // Normalize to string: API returns id as string, but button clicks set it
      // via Number(btn.dataset.profileId) — strict equality would always miss.
      const p = data.profiles.find(pr => String(pr.id) === String(profileId));
      if (!p || p.profile_type !== 'person') { nudgeEl.hidden = true; return; }
      const pct = p.voice_profile_completion_pct || 0;
      if (pct < 40) {
        nudgeEl.innerHTML = `Posts for <strong>${escapeHtml(p.display_name)}</strong> may not match your voice yet. <a href="/settings.html">Set up voice profile →</a>`;
        nudgeEl.hidden = false;
      } else {
        nudgeEl.hidden = true;
      }
    }

    btnsEl.querySelectorAll('.profile-sel-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _selectedProfileId = Number(btn.dataset.profileId);
        btnsEl.querySelectorAll('.profile-sel-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updateVoiceNudge(_selectedProfileId);
      });
    });

    // Run nudge check for the initially selected profile
    updateVoiceNudge(_selectedProfileId);

    selector.style.display = '';
  } catch { /* non-fatal — falls back to workspace default profile */ }
}

/* ── Init ────────────────────────────────────────────────────── */
async function init() {
  await window.scouthookAuthReady;

  // Default to reach immediately; loadMixRecommendation may update this
  selectType('reach');

  loadMixRecommendation();    // fire-and-forget — updates active btn if mix recommends a type
  checkProfileGate();         // fire-and-forget — nudge appears if profile is empty
  prefetchIdeas();            // fire-and-forget — warms idea cache for instant vault panel
  loadProfileSelector();      // fire-and-forget — shows "Creating for" selector if >1 profile

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
}


window.__pageInit = init;
window.__pageCleanup = function () {
  clearTimeout(_tensionDebounce);
  clearTimeout(_nudgeDebounce);
  _tensionDebounce = null;
  _nudgeDebounce = null;
};

init();

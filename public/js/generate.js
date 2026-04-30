/* generate.js — idea input and submission for generate.html */

/* ── 1. DOM references ───────────────────────────────────────── */
const ideaInput       = document.getElementById('idea-input');
const ideaError       = document.getElementById('idea-error');
const generateBtn     = document.getElementById('generate-btn');
const voiceIndicator  = document.getElementById('voice-indicator-area');
const generatingState = document.getElementById('generating-state');
const generateError   = document.getElementById('generate-error');

/* ── 2. Auto-grow textarea ───────────────────────────────────── */
ideaInput.addEventListener('input', () => {
  ideaInput.style.height = 'auto';
  ideaInput.style.height = ideaInput.scrollHeight + 'px';
  clearError();
});

/* ── 3. Voice profile indicator ─────────────────────────────── */
async function loadProfile() {
  try {
    const uid = getUserId();
    const res = await fetch(`/api/profile/${uid}`, { headers: apiHeaders() });
    const data = await res.json();
    const profile = data.profile;
    const complete = profile && profile.content_niche && profile.audience_role && profile.audience_pain;
    if (complete) {
      voiceIndicator.innerHTML = `<div class="voice-indicator"><span class="voice-indicator-dot voice-indicator-dot--green"></span><a href="/profile.html" class="edit-link">Created using your voice profile</a></div>`;
    } else {
      voiceIndicator.innerHTML = `<div class="voice-indicator"><span class="voice-indicator-dot voice-indicator-dot--red"></span><a href="/profile.html" class="edit-link">Voice profile incomplete — complete it for better results</a></div>`;
    }
  } catch {
    voiceIndicator.innerHTML = `<div class="voice-indicator"><span class="voice-indicator-dot voice-indicator-dot--red"></span><a href="/profile.html" class="edit-link">Voice profile incomplete — complete it for better results</a></div>`;
  }
}

/* ── 4. Generate ─────────────────────────────────────────────── */
generateBtn.addEventListener('click', () => triggerGenerate());

async function triggerGenerate() {
  clearError();

  const idea = ideaInput.value.trim();
  if (!idea) {
    showInputError('Add a thought before writing the post');
    ideaInput.focus();
    return;
  }
  if (idea.length < 80) {
    showInputError('Add more of your own words — a few sentences gives us more to work with.');
    ideaInput.focus();
    return;
  }

  setGenerating(true);

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch('/api/generate', {
      method:  'POST',
      headers: apiHeaders(),
      body:    JSON.stringify({ path: 'idea', raw_idea: idea }),
      signal:  controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json();

    if (!res.ok || !data.ok) {
      const err = new Error(data.error || 'Generation failed');
      if (data.error === 'plan_limit_exceeded') {
        err.planCurrent = data.current;
        err.planLimit   = data.limit;
      }
      throw err;
    }

    window.location.href = `/preview.html?post_id=${encodeURIComponent(data.id)}`;

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      showGenerateError('This is taking too long. <a href="#">Try again →</a>');
    } else if (err.message === 'complete_profile_first') {
      showGenerateError('Your voice profile is incomplete — posts need it to generate. <a href="/profile.html">Complete it →</a>');
    } else if (err.message === 'plan_limit_exceeded') {
      const used = (err.planCurrent !== undefined && err.planLimit !== undefined)
        ? ` You've used ${err.planCurrent} of ${err.planLimit} this month.` : '';
      showGenerateError(`You've reached the free plan generation limit.${used} <button type="button" onclick="window.PricingModal?.open()" style="background:none;border:none;padding:0;color:var(--brand);font-weight:600;cursor:pointer;font-size:inherit">Upgrade to Pro →</button>`);
    } else {
      showGenerateError('Something went wrong. <a href="#">Try again →</a>');
    }
    setGenerating(false);
  }
}

/* ── 5. UI helpers ───────────────────────────────────────────── */
function setGenerating(loading) {
  generateBtn.disabled    = loading;
  generateBtn.textContent = loading ? 'Writing the post…' : 'Write the post';
  generatingState.classList.toggle('visible', loading);
  if (loading) ideaInput.readOnly = true;
  else ideaInput.readOnly = false;
}

function showInputError(msg) {
  ideaInput.classList.add('error');
  ideaError.textContent = msg;
  ideaError.classList.add('visible');
}

function showGenerateError(html) {
  generateError.innerHTML = html;
  generateError.classList.add('visible');
  // Wire up "Try again" links in the error message
  const tryLink = generateError.querySelector('a[href="#"]');
  if (tryLink) tryLink.addEventListener('click', (e) => { e.preventDefault(); triggerGenerate(); });
}

function clearError() {
  ideaInput.classList.remove('error');
  ideaError.classList.remove('visible');
  generateError.classList.remove('visible');
}

/* ── 6. Init ─────────────────────────────────────────────────── */
(async function init() {
  await window.scouthookAuthReady;
  await loadProfile();

  // Focus the textarea on load for immediate typing
  ideaInput.focus();
})();

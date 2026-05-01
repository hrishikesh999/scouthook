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

/* ── 6. Mode switcher ────────────────────────────────────────── */
const modeBtns      = document.querySelectorAll('.gen-mode-btn');
const paneIdea      = document.getElementById('gen-pane-idea');
const paneVault     = document.getElementById('gen-pane-vault');

modeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    modeBtns.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    const mode = btn.dataset.mode;
    paneIdea.style.display  = mode === 'idea'  ? '' : 'none';
    paneVault.style.display = mode === 'vault' ? '' : 'none';
    if (mode === 'vault' && !vaultLoaded) loadVaultPane();
  });
});

/* ── 7. Vault mode ───────────────────────────────────────────── */
let hasPositioning = false;
let vaultLoaded    = false;

const vaultDocStatus    = document.getElementById('gen-vault-doc-status');
const positioningPrompt = document.getElementById('gen-positioning-prompt');
const positioningInput  = document.getElementById('gen-positioning-input');
const positioningSave   = document.getElementById('gen-positioning-save');
const vaultBtn          = document.getElementById('gen-vault-btn');
const vaultRunStatus    = document.getElementById('gen-vault-run-status');

async function loadVaultPane() {
  vaultLoaded = true;
  try {
    const [docsRes, profileRes] = await Promise.all([
      fetch('/api/vault/documents'),
      fetch('/api/profile/me'),
    ]);
    const docsData    = await docsRes.json();
    const profileData = await profileRes.json();
    const readyDocs   = (docsData.documents || []).filter(d => d.status === 'ready');
    hasPositioning    = !!(profileData.ok && profileData.profile?.business_positioning);
    renderVaultDocStatus(readyDocs.length);
  } catch {
    vaultDocStatus.innerHTML = '<p style="font-size:0.875rem;color:var(--text-muted);margin:0">Could not load vault status. Try refreshing.</p>';
  }
}

function renderVaultDocStatus(count) {
  if (count === 0) {
    vaultDocStatus.innerHTML = `
      <div class="gen-vault-empty">
        <span>No documents in your Content Vault yet. Upload case studies, service docs, or newsletters to get started.</span>
        <a href="/vault.html" class="gen-vault-link">Go to Vault →</a>
      </div>`;
    vaultBtn.disabled = true;
  } else {
    vaultDocStatus.innerHTML = `
      <div class="gen-vault-doc-count">
        <span class="gen-vault-doc-count-text"><strong>${count}</strong> document${count === 1 ? '' : 's'} ready in your Vault</span>
        <a href="/vault.html" class="gen-vault-link">Manage Vault →</a>
      </div>`;
    vaultBtn.disabled = false;
    if (!hasPositioning) positioningPrompt.style.display = '';
  }
}

positioningSave.addEventListener('click', async () => {
  const val = positioningInput.value.trim();
  if (!val) { positioningInput.focus(); return; }
  positioningSave.disabled = true;
  try {
    const res  = await fetch('/api/profile', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ business_positioning: val }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    hasPositioning = true;
    positioningPrompt.style.display = 'none';
    runWeeklyBatch();
  } catch (err) {
    positioningSave.disabled = false;
    setVaultRunStatus(`Could not save: ${err.message}`, 'error');
  }
});

positioningInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') positioningSave.click();
});

vaultBtn.addEventListener('click', () => {
  if (!hasPositioning) {
    positioningPrompt.style.display = '';
    positioningInput.focus();
    setVaultRunStatus('Complete the box above first, then click "Got it →"', 'info');
    return;
  }
  runWeeklyBatch();
});

async function runWeeklyBatch() {
  vaultBtn.disabled = true;
  setVaultRunStatus('Writing your posts… this takes about 30 seconds.', 'info');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    let res;
    try {
      res = await fetch('/api/generate/weekly-batch', { method: 'POST', signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    const data = await res.json();
    if (!data.ok) {
      if (data.error === 'ghostwriter_prompt_not_ready') {
        setVaultRunStatus('Your Voice Profile needs a bit more info — complete Content Niche + Audience first.', 'error');
        vaultRunStatus.innerHTML += ' <a href="/profile.html" style="color:var(--brand);font-weight:600">Complete Voice Profile →</a>';
      } else if (data.error === 'rate_limit_exceeded') {
        setVaultRunStatus('Rate limit reached — try again in an hour.', 'error');
      } else {
        setVaultRunStatus(data.message || data.error || 'Something went wrong. Please try again.', 'error');
      }
      return;
    }
    window.location.href = `/preview.html?batch_id=${encodeURIComponent(data.batch_id)}`;
  } catch (err) {
    setVaultRunStatus(`Failed: ${err.message}`, 'error');
  } finally {
    vaultBtn.disabled = false;
  }
}

function setVaultRunStatus(msg, type) {
  vaultRunStatus.textContent = msg;
  vaultRunStatus.className   = `gen-vault-run-status ${type}`;
}

/* ── 8. Init ─────────────────────────────────────────────────── */
(async function init() {
  await window.scouthookAuthReady;
  await loadProfile();

  // Auto-switch to vault tab if ?mode=vault is in the URL
  if (new URLSearchParams(location.search).get('mode') === 'vault') {
    document.querySelector('[data-mode="vault"]').click();
  } else {
    ideaInput.focus();
  }
})();

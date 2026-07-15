// Connect Claude (MCP) card on account.html.
// Talks to /api/mcp-tokens (session-authed, workspace-scoped) to list, create,
// and revoke MCP personal access tokens. The raw token is only ever available in
// the create response, so we reveal it once and never re-fetch it.
(function () {
  'use strict';

  var card = document.getElementById('mcp-connector-card');
  if (!card) return;

  var urlEl        = document.getElementById('mcp-url');
  var urlCopy      = document.getElementById('mcp-url-copy');
  var labelInput   = document.getElementById('mcp-token-label');
  var createBtn    = document.getElementById('mcp-token-create');
  var listWrap     = document.getElementById('mcp-token-list');
  var rowsEl       = document.getElementById('mcp-token-rows');
  var emptyEl      = document.getElementById('mcp-token-empty');
  var feedbackEl   = document.getElementById('mcp-feedback');
  var newTokenWrap = document.getElementById('mcp-new-token');
  var newTokenVal  = document.getElementById('mcp-new-token-value');
  var newTokenCopy = document.getElementById('mcp-new-token-copy');

  function feedback(msg, isError) {
    feedbackEl.textContent = msg;
    feedbackEl.style.display = 'block';
    feedbackEl.style.color = isError ? 'var(--score-fail,#dc2626)' : 'var(--text-success,#10B981)';
    if (!isError) setTimeout(function () { feedbackEl.style.display = 'none'; }, 3000);
  }

  function copyText(text, btn) {
    navigator.clipboard.writeText(text).then(function () {
      var prev = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = prev; }, 1500);
    }).catch(function () { feedback('Copy failed — select and copy manually.', true); });
  }

  function fmtDate(s) {
    if (!s) return 'never';
    try { return new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return s; }
  }

  function renderTokens(tokens) {
    rowsEl.innerHTML = '';
    var active = (tokens || []).filter(function (t) { return !t.revoked_at; });
    if (!active.length) {
      listWrap.style.display = 'none';
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';
    listWrap.style.display = 'block';
    active.forEach(function (t) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--border)';
      var meta = document.createElement('div');
      meta.style.cssText = 'min-width:0';
      var name = document.createElement('div');
      name.style.cssText = 'font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      name.textContent = t.label || 'Token';
      var sub = document.createElement('div');
      sub.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:2px';
      sub.textContent = t.token_prefix + '…  ·  created ' + fmtDate(t.created_at) +
        '  ·  last used ' + fmtDate(t.last_used_at);
      meta.appendChild(name); meta.appendChild(sub);
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-outlined';
      del.style.cssText = 'font-size:12px;height:30px;padding:0 12px;flex-shrink:0;color:var(--score-fail,#dc2626)';
      del.textContent = 'Revoke';
      del.addEventListener('click', function () { revoke(t.id, del); });
      row.appendChild(meta); row.appendChild(del);
      rowsEl.appendChild(row);
    });
  }

  function load() {
    return fetch('/api/mcp-tokens', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { feedback('Could not load your tokens.', true); return; }
        if (d.mcp_url) urlEl.textContent = d.mcp_url;
        renderTokens(d.tokens);
      })
      .catch(function () { feedback('Could not load your tokens.', true); });
  }

  function create() {
    createBtn.disabled = true;
    fetch('/api/mcp-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ label: labelInput.value.trim() }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok || !d.token) { feedback('Could not create a token. Try again.', true); return; }
        newTokenVal.textContent = d.token;
        newTokenWrap.style.display = 'block';
        labelInput.value = '';
        feedback('Token created. Copy it now — it won’t be shown again.', false);
        load();
      })
      .catch(function () { feedback('Could not create a token. Try again.', true); })
      .finally(function () { createBtn.disabled = false; });
  }

  function revoke(id, btn) {
    if (!window.confirm('Revoke this token? Any Claude connection using it will stop working.')) return;
    btn.disabled = true;
    fetch('/api/mcp-tokens/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { feedback('Could not revoke the token.', true); btn.disabled = false; return; }
        feedback('Token revoked.', false);
        load();
      })
      .catch(function () { feedback('Could not revoke the token.', true); btn.disabled = false; });
  }

  urlCopy.addEventListener('click', function () { copyText(urlEl.textContent, urlCopy); });
  newTokenCopy.addEventListener('click', function () { copyText(newTokenVal.textContent, newTokenCopy); });
  createBtn.addEventListener('click', create);
  labelInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') create(); });

  load();
})();

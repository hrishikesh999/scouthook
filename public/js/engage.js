'use strict';

/**
 * engage.js — the conversation layer UI (Authentic Client Engine, Phase 5).
 * Two paste-mode tools: reply/DM drafts and a profile-as-landing-page audit.
 * Nothing is auto-posted; everything is copy-to-clipboard.
 */
(function () {
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function headers() {
    return (typeof apiHeaders === 'function') ? apiHeaders() : { 'Content-Type': 'application/json' };
  }
  function toast(msg) { if (window.toast) window.toast(msg); }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch { toast('Copy failed — select and copy manually'); }
  }

  // ── Tabs ──────────────────────────────────────────────────────
  document.querySelectorAll('.engage-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.engage-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.engage-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.querySelector(`.engage-panel[data-panel="${tab.dataset.tab}"]`)?.classList.add('active');
    });
  });

  // ── Reply / DM mode toggle ────────────────────────────────────
  let replyMode = 'reply';
  document.querySelectorAll('#reply-mode button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#reply-mode button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      replyMode = btn.dataset.mode;
    });
  });

  // ── Reply / DM draft ──────────────────────────────────────────
  const replyGo = document.getElementById('reply-go');
  replyGo?.addEventListener('click', async () => {
    const commentText = document.getElementById('reply-comment').value.trim();
    if (!commentText) { toast('Paste a comment first'); return; }
    const postText = document.getElementById('reply-post').value.trim();
    const commenterName = document.getElementById('reply-name').value.trim();

    replyGo.disabled = true;
    replyGo.textContent = 'Drafting…';
    try {
      const res = await fetch('/api/posts/reply-draft', {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentText, postText, commenterName, mode: replyMode }),
      });
      const data = await res.json();
      const box = document.getElementById('reply-result');
      const draftEl = document.getElementById('reply-draft');
      if (data.ok && data.draft) {
        draftEl.textContent = data.draft;
        box.hidden = false;
        document.getElementById('reply-copy').onclick = () => copy(data.draft);
      } else {
        toast('Could not draft that one — try again');
      }
    } catch {
      toast('Something went wrong');
    } finally {
      replyGo.disabled = false;
      replyGo.textContent = 'Draft it →';
    }
  });

  // ── Profile audit ─────────────────────────────────────────────
  const auditGo = document.getElementById('audit-go');
  auditGo?.addEventListener('click', async () => {
    const headline = document.getElementById('audit-headline').value.trim();
    const about = document.getElementById('audit-about').value.trim();
    if (!headline && !about) { toast('Paste your headline or About first'); return; }

    auditGo.disabled = true;
    auditGo.textContent = 'Auditing…';
    try {
      const res = await fetch('/api/profile/linkedin-audit', {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ headline, about }),
      });
      const data = await res.json();
      const box = document.getElementById('audit-result');
      if (data.ok && data.audit) {
        box.innerHTML = renderAudit(data.audit);
        box.hidden = false;
        box.querySelectorAll('[data-copy]').forEach(el => {
          el.addEventListener('click', () => copy(el.getAttribute('data-copy')));
        });
      } else {
        toast('Could not audit that — try again');
      }
    } catch {
      toast('Something went wrong');
    } finally {
      auditGo.disabled = false;
      auditGo.textContent = 'Audit my profile →';
    }
  });

  function renderAudit(a) {
    const parts = [];
    if (a.score !== null && a.score !== undefined) {
      parts.push(`<div><span class="audit-score">${esc(String(a.score))}</span><span style="color:var(--text-secondary)">/100</span></div>`);
    }
    if (a.verdict) parts.push(`<p style="margin:6px 0 0;font-size:14.5px;line-height:1.5">${esc(a.verdict)}</p>`);
    if (a.headline_rewrites?.length) {
      parts.push(`<div class="audit-block"><h4>Headline options</h4><ul class="audit-list">${
        a.headline_rewrites.map(h => `<li>${esc(h)} <button class="engage-copy" style="margin:0 0 0 6px;padding:2px 8px" data-copy="${esc(h)}">Copy</button></li>`).join('')
      }</ul></div>`);
    }
    if (a.about_suggestions?.length) {
      parts.push(`<div class="audit-block"><h4>Sharpen your About</h4><ul class="audit-list">${
        a.about_suggestions.map(s => `<li>${esc(s)}</li>`).join('')
      }</ul></div>`);
    }
    if (a.next_step) parts.push(`<div class="audit-block"><h4>End with this</h4><p style="margin:0;font-size:14px;line-height:1.5">${esc(a.next_step)}</p></div>`);
    return parts.join('');
  }
})();

'use strict';

let templates = [];
let dragSrcId  = null;

// ── API helpers ──────────────────────────────────────────────────────────────

function apiHeaders() {
  const ws = window._activeWorkspaceId || localStorage.getItem('activeWorkspaceId') || '';
  const h  = { 'Content-Type': 'application/json' };
  if (ws) h['X-Workspace-Id'] = ws;
  return h;
}

async function apiGet(path) {
  const r = await fetch(path, { headers: apiHeaders(), credentials: 'include' });
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(path, { method: 'POST', headers: apiHeaders(), credentials: 'include', body: JSON.stringify(body) });
  return r.json();
}

async function apiPut(path, body) {
  const r = await fetch(path, { method: 'PUT', headers: apiHeaders(), credentials: 'include', body: JSON.stringify(body) });
  return r.json();
}

async function apiDel(path) {
  const r = await fetch(path, { method: 'DELETE', headers: apiHeaders(), credentials: 'include' });
  return r.json();
}

// ── Render ───────────────────────────────────────────────────────────────────

function initials(name) {
  return (name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderGrid() {
  const grid  = document.getElementById('templates-grid');
  const empty = document.getElementById('templates-empty');

  if (templates.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  grid.innerHTML = templates.map(t => {
    const previewHtml = t.preview_image_url
      ? `<img src="${escHtml(t.preview_image_url)}" alt="${escHtml(t.name)} preview" loading="lazy">`
      : `<span class="template-card-preview-placeholder">${escHtml(initials(t.name))}</span>`;
    const defaultBadge = t.is_default ? '<span class="template-badge-default">Default</span>' : '';
    const shortUuid = (t.template_uuid || '').slice(0, 18) + (t.template_uuid?.length > 18 ? '…' : '');
    return `
      <div class="template-card" draggable="true" data-id="${escHtml(t.id)}">
        <div class="template-card-preview">${previewHtml}</div>
        <div class="template-card-body">
          <div class="template-card-name">${escHtml(t.name)} ${defaultBadge}</div>
          <div class="template-card-uuid" title="Click to copy UUID">${escHtml(shortUuid)}</div>
          <div class="template-card-layers">headline → <code>${escHtml(t.layer_headline)}</code> · subtext → <code>${escHtml(t.layer_subtext)}</code></div>
        </div>
        <div class="template-card-actions">
          <button class="btn-template-action" data-action="edit"    data-id="${escHtml(t.id)}">Edit</button>
          <button class="btn-template-action" data-action="default" data-id="${escHtml(t.id)}"${t.is_default ? ' disabled' : ''}>Set Default</button>
          <button class="btn-template-action danger" data-action="delete" data-id="${escHtml(t.id)}">Delete</button>
        </div>
      </div>`;
  }).join('');

  wireCardEvents();
}

// ── Card events: actions + drag-to-reorder ───────────────────────────────────

function wireCardEvents() {
  const grid = document.getElementById('templates-grid');

  grid.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async e => {
      const { action, id } = e.currentTarget.dataset;
      if (action === 'edit')    openModal(templates.find(t => t.id === id));
      if (action === 'default') await setDefault(id);
      if (action === 'delete')  await deleteTemplate(id);
    });
  });

  grid.querySelectorAll('.template-card-uuid').forEach(el => {
    el.addEventListener('click', () => {
      const t = templates.find(t => t.id === el.closest('.template-card').dataset.id);
      if (t) navigator.clipboard?.writeText(t.template_uuid).catch(() => {});
    });
  });

  // Drag-to-reorder
  grid.querySelectorAll('.template-card').forEach(card => {
    card.addEventListener('dragstart', e => {
      dragSrcId = card.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      grid.querySelectorAll('.template-card').forEach(c => c.classList.remove('drag-over'));
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', async e => {
      e.preventDefault();
      card.classList.remove('drag-over');
      if (!dragSrcId || dragSrcId === card.dataset.id) return;

      const fromIdx = templates.findIndex(t => t.id === dragSrcId);
      const toIdx   = templates.findIndex(t => t.id === card.dataset.id);
      if (fromIdx < 0 || toIdx < 0) return;

      const reordered = [...templates];
      const [moved]   = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved);
      templates = reordered;
      renderGrid();

      await apiPost('/api/placid-templates/reorder', { ids: reordered.map(t => t.id) });
    });
  });
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function setDefault(id) {
  const data = await apiPost(`/api/placid-templates/${encodeURIComponent(id)}/set-default`, {});
  if (data.ok) {
    templates = templates.map(t => ({ ...t, is_default: t.id === id }));
    renderGrid();
  }
}

async function deleteTemplate(id) {
  const t = templates.find(t => t.id === id);
  if (!t || !confirm(`Delete template "${t.name}"?`)) return;
  const data = await apiDel(`/api/placid-templates/${encodeURIComponent(id)}`);
  if (data.ok) {
    templates = templates.filter(t => t.id !== id);
    renderGrid();
  }
}

// ── Modal ────────────────────────────────────────────────────────────────────

function openModal(template = null) {
  const modal = document.getElementById('template-modal');
  document.getElementById('modal-title').textContent     = template ? 'Edit Template' : 'Add Template';
  document.getElementById('modal-edit-id').value         = template?.id || '';
  document.getElementById('modal-name').value            = template?.name || '';
  document.getElementById('modal-uuid').value            = template?.template_uuid || '';
  document.getElementById('modal-layer-headline').value  = template?.layer_headline || 'headline';
  document.getElementById('modal-layer-subtext').value   = template?.layer_subtext  || 'subtext';
  document.getElementById('modal-preview').value         = template?.preview_image_url || '';
  document.getElementById('modal-error').textContent     = '';
  document.getElementById('modal-error').classList.add('hidden');
  document.getElementById('modal-save').disabled         = false;
  modal.classList.remove('hidden');
  document.getElementById('modal-name').focus();
}

function closeModal() {
  document.getElementById('template-modal').classList.add('hidden');
}

async function saveModal() {
  const id      = document.getElementById('modal-edit-id').value;
  const payload = {
    name:              document.getElementById('modal-name').value.trim(),
    template_uuid:     document.getElementById('modal-uuid').value.trim(),
    layer_headline:    document.getElementById('modal-layer-headline').value.trim() || 'headline',
    layer_subtext:     document.getElementById('modal-layer-subtext').value.trim()  || 'subtext',
    preview_image_url: document.getElementById('modal-preview').value.trim() || null,
  };

  const errEl  = document.getElementById('modal-error');
  const saveBtn = document.getElementById('modal-save');

  if (!payload.name || !payload.template_uuid) {
    errEl.textContent = 'Name and template UUID are required.';
    errEl.classList.remove('hidden');
    return;
  }

  saveBtn.disabled = true;
  const data = id
    ? await apiPut(`/api/placid-templates/${encodeURIComponent(id)}`, payload)
    : await apiPost('/api/placid-templates', payload);

  if (!data.ok) {
    errEl.textContent = data.error || 'Save failed.';
    errEl.classList.remove('hidden');
    saveBtn.disabled = false;
    return;
  }

  if (id) {
    templates = templates.map(t => t.id === id ? data.template : t);
  } else {
    templates = [...templates, data.template];
  }
  renderGrid();
  closeModal();
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const data = await apiGet('/api/placid-templates');
  templates  = data.templates || [];
  renderGrid();

  document.getElementById('btn-add-template').addEventListener('click', () => openModal());
  document.getElementById('btn-add-template-empty')?.addEventListener('click', () => openModal());
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', saveModal);
  document.getElementById('template-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });
}

init();

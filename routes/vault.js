'use strict';

/**
 * routes/vault.js — Intelligence Vault API
 *
 * POST   /api/vault/upload          Upload a file (PDF/DOCX/TXT) or submit a URL
 * GET    /api/vault/documents        List user's vault documents
 * DELETE /api/vault/documents/:id    Delete a document (cascades chunks + ideas)
 * POST   /api/vault/mine             Trigger idea mining on all ready documents
 * GET    /api/vault/ideas            List ideas (filter: status, funnel_type)
 * PATCH  /api/vault/ideas/:id        Update idea status (saved / discarded / fresh)
 */

const express     = require('express');
const router      = express.Router();
const { db }      = require('../db');
const storage     = require('../services/storage');
const { extractAndChunk, extractAndChunkUrl, classifyChunks, chunkText, extractYoutube, extractGoogleDrive } = require('../services/vaultMiner');
const { canUploadVaultDoc } = require('../services/subscription');

const HAIKU_MODEL  = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-6';

const ALLOWED_MIME = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/plain']);
const MIME_TO_TYPE = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
};
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

// ---------------------------------------------------------------------------
// Helper: fetch the workspace's default profile with brand voice + audience
// ---------------------------------------------------------------------------
async function fetchMiningProfile(tenantId) {
  return db.prepare(`
    SELECT p.voice_fingerprint, p.onboarding_q2, p.content_pillars,
           p.authority_statements, p.input_examples, p.writing_samples,
           bvp.brand_industry, bvp.brand_description, bvp.elevator_main_result,
           bvp.brand_core_beliefs, bvp.brand_personality_traits,
           bvp.brand_archetype, bvp.brand_phrases_to_use,
           ap.audience_description, ap.audience_goals, ap.audience_obstacles,
           ap.audience_core_beliefs_market
    FROM profiles p
    LEFT JOIN brand_voice_profiles bvp ON bvp.profile_id = p.id
    LEFT JOIN audience_profiles ap ON ap.profile_id = p.id
    WHERE p.workspace_id = ? AND p.is_default = true
  `).get(tenantId);
}

// ---------------------------------------------------------------------------
// Helper: detect the source type of a URL
// ---------------------------------------------------------------------------
function detectUrlSourceType(url) {
  if (/youtube\.com\/watch|youtu\.be\//.test(url)) return 'youtube';
  if (/docs\.google\.com\/document/.test(url))     return 'gdrive';
  return 'url';
}

// ---------------------------------------------------------------------------
// Helper: require authenticated user
// ---------------------------------------------------------------------------
function requireUser(req, res) {
  if (!req.userId) {
    res.status(400).json({ ok: false, error: 'missing_user_id' });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// POST /api/vault/upload
// Body: raw binary for files | JSON { url } for URL ingestion
// Headers (files only): Content-Type, X-Filename (URI-encoded)
// ---------------------------------------------------------------------------
router.post('/upload', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  const planCheck = await canUploadVaultDoc(userId);
  if (!planCheck.allowed) {
    return res.status(403).json({
      ok: false,
      error: 'plan_limit_exceeded',
      plan: planCheck.plan,
      current: planCheck.current,
      limit: planCheck.limit,
      upgrade_url: '/billing.html',
    });
  }

  const contentType = (req.headers['content-type'] || '').split(';')[0].trim();

  // ── URL ingestion ──────────────────────────────────────────────────────────
  if (contentType === 'application/json') {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ ok: false, error: 'url_required' });
    }
    let parsed;
    try { parsed = new URL(url); } catch {
      return res.status(400).json({ ok: false, error: 'invalid_url' });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ ok: false, error: 'invalid_url_protocol' });
    }

    const srcType = detectUrlSourceType(parsed.href);
    const filename = (
      srcType === 'youtube' ? `YouTube: ${parsed.hostname}${parsed.pathname}` :
      srcType === 'gdrive'  ? `Google Doc: ${parsed.hostname}${parsed.pathname}` :
      parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname : '')
    );

    // Create the document record immediately (pending)
    const docResult = await db.prepare(`
      INSERT INTO vault_documents (user_id, tenant_id, filename, source_type, source_url, status)
      VALUES (?, ?, ?, ?, ?, 'indexing')
      RETURNING id
    `).run(userId, tenantId, filename.slice(0, 200), srcType, url);
    const docId = docResult.lastInsertRowid;

    // Process asynchronously so the HTTP response returns immediately
    setImmediate(() => processUrl(docId, url, srcType, filename, userId, tenantId));

    return res.json({ ok: true, document: { id: docId, filename, source_type: srcType, status: 'indexing' } });
  }

  // ── File upload ────────────────────────────────────────────────────────────
  // Use express.raw() inline to handle binary body
  express.raw({ type: '*/*', limit: '26mb' })(req, res, async () => {
    const mimeType = contentType;
    const filename = (() => {
      try { return decodeURIComponent(req.headers['x-filename'] || ''); } catch { return ''; }
    })();

    if (!filename) return res.status(400).json({ ok: false, error: 'x_filename_header_required' });
    if (!ALLOWED_MIME.has(mimeType)) {
      return res.status(415).json({ ok: false, error: 'unsupported_file_type', allowed: ['pdf', 'docx', 'txt'] });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ ok: false, error: 'empty_body' });
    }
    if (req.body.length > MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'file_too_large', max_mb: 25 });
    }

    const sourceType  = MIME_TO_TYPE[mimeType];
    const storageKey  = storage.buildVaultKey(tenantId, filename);

    // Upload to storage first
    try {
      await storage.uploadToKey(req.body, storageKey, mimeType);
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'storage_upload_failed', detail: err.message });
    }

    // Create document record
    const docResult = await db.prepare(`
      INSERT INTO vault_documents (user_id, tenant_id, filename, source_type, storage_key, status)
      VALUES (?, ?, ?, ?, ?, 'indexing')
      RETURNING id
    `).run(userId, tenantId, filename, sourceType, storageKey);
    const docId = docResult.lastInsertRowid;

    // Process asynchronously
    const bodyBuffer = req.body;
    setImmediate(() => processFile(docId, bodyBuffer, sourceType, filename, userId, tenantId));

    return res.json({ ok: true, document: { id: docId, filename, source_type: sourceType, status: 'indexing' } });
  });
});

// ── Async processing: file ────────────────────────────────────────────────────
async function processFile(docId, buffer, sourceType, filename, userId, tenantId) {
  try {
    const chunks = await extractAndChunk(buffer, sourceType, filename);
    await saveChunks(docId, chunks, userId, tenantId);
  } catch (err) {
    console.error(`[vault] processFile failed doc=${docId}:`, err.message);
    await db.prepare(`
      UPDATE vault_documents SET status = 'error', error_message = ?, updated_at = now() WHERE id = ?
    `).run(err.message.slice(0, 500), docId);
    return;
  }
  // Mine immediately after extraction — no frontend poll needed
  try {
    await mineDocumentById(docId, userId, tenantId);
  } catch (err) {
    console.error(`[vault] auto-mining failed doc=${docId}:`, err.message);
    await db.prepare(`
      UPDATE vault_documents SET status = 'error', error_message = ?, updated_at = now() WHERE id = ?
    `).run(('Mining failed: ' + err.message).slice(0, 500), docId);
  }
}

// ── Async processing: url ─────────────────────────────────────────────────────
async function processUrl(docId, url, srcType, filename, userId, tenantId) {
  try {
    let chunks;
    if (srcType === 'youtube') {
      const { text } = await extractYoutube(url);
      if (!text || text.trim().length < 50) throw new Error('YouTube video has no accessible transcript or description');
      chunks = chunkText(text, null);
    } else if (srcType === 'gdrive') {
      const { text } = await extractGoogleDrive(url);
      chunks = chunkText(text, null);
    } else {
      chunks = await extractAndChunkUrl(url);
    }
    await saveChunks(docId, chunks, userId, tenantId);
  } catch (err) {
    console.error(`[vault] processUrl failed doc=${docId}:`, err.message);
    await db.prepare(`
      UPDATE vault_documents SET status = 'error', error_message = ?, updated_at = now() WHERE id = ?
    `).run(err.message.slice(0, 500), docId);
    return;
  }
  try {
    await mineDocumentById(docId, userId, tenantId);
  } catch (err) {
    console.error(`[vault] auto-mining failed doc=${docId}:`, err.message);
    await db.prepare(`
      UPDATE vault_documents SET status = 'error', error_message = ?, updated_at = now() WHERE id = ?
    `).run(('Mining failed: ' + err.message).slice(0, 500), docId);
  }
}

// ── Save chunks to DB and transition to 'mining' ──────────────────────────────
async function saveChunks(docId, chunks, userId, tenantId) {
  if (!chunks || chunks.length === 0) {
    await db.prepare(`
      UPDATE vault_documents SET status = 'error', error_message = 'No text could be extracted', updated_at = now() WHERE id = ?
    `).run(docId);
    return;
  }

  const insertChunk = db.prepare(`
    INSERT INTO vault_chunks (document_id, user_id, tenant_id, chunk_index, content, source_ref)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const chunk of chunks) {
    await insertChunk.run(docId, userId, tenantId, chunk.chunkIndex, chunk.content, chunk.sourceRef);
  }

  // 'mining' signals that extraction is done and AI mining is about to start.
  // The document only transitions to 'ready' after mineDocumentById completes.
  await db.prepare(`
    UPDATE vault_documents SET status = 'mining', chunk_count = ?, updated_at = now() WHERE id = ?
  `).run(chunks.length, docId);

  console.log(`[vault] doc=${docId} indexed ${chunks.length} chunks — starting mining`);
}

// ── Server-side mining for a single document ──────────────────────────────────
// Called automatically after extraction so mining runs regardless of whether
// the user stays on the vault page. The frontend only needs to poll for status.
// Classify one document's unmined chunks into vault_insights, mark them mined,
// and record the insight count. Shared by the auto-process path and POST /mine.
// (vault_chunks.mined_at doubles as "classified_at" — same one-pass semantics.)
async function classifyAndStoreDoc(docId, chunks, filename, userProfile, userId, tenantId) {
  const insights = await classifyChunks(chunks, filename, userProfile);

  // Persist insights → mark chunks classified → flip status, atomically and in
  // that order. .run() is async and MUST be awaited: firing them un-awaited
  // races status='ready' ahead of the inserts (panel shows a wrong count) and
  // swallows insert failures. A transaction means a mid-write failure rolls back
  // and leaves the chunks unmined, so POST /mine can retry the document.
  await db.transaction(async (tx) => {
    const insertInsight = tx.prepare(`
      INSERT INTO vault_insights (user_id, tenant_id, document_id, category, content, source_ref)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const ins of insights) {
      await insertInsight.run(userId, tenantId, docId, ins.category, ins.content, ins.source_ref || null);
    }
    if (chunks.length) {
      const ids = chunks.map(() => '?').join(',');
      await tx.prepare(`UPDATE vault_chunks SET mined_at = now() WHERE id IN (${ids})`).run(...chunks.map(c => c.id));
    }
    await tx.prepare(`
      UPDATE vault_documents SET status = 'ready', ideas_mined = ideas_mined + ?, updated_at = now() WHERE id = ?
    `).run(insights.length, docId);
  });

  return insights.length;
}

async function mineDocumentById(docId, userId, tenantId) {
  const unmined = await db.prepare(`
    SELECT vc.id, vc.document_id, vc.chunk_index, vc.content, vc.source_ref,
           vd.filename
    FROM   vault_chunks vc
    JOIN   vault_documents vd ON vd.id = vc.document_id
    WHERE  vc.document_id = ?
      AND  vc.tenant_id   = ?
      AND  vc.mined_at IS NULL
    ORDER  BY vc.chunk_index
  `).all(docId, tenantId);

  if (unmined.length === 0) {
    await db.prepare(`UPDATE vault_documents SET status = 'ready', updated_at = now() WHERE id = ?`).run(docId);
    return;
  }

  const filename    = unmined[0].filename;
  const userProfile = await fetchMiningProfile(tenantId) || {};
  const n = await classifyAndStoreDoc(docId, unmined, filename, userProfile, userId, tenantId);

  console.log(`[vault] doc=${docId} classified into ${n} insights`);

  // Second stage: bundle the insights into angles. Deliberately NOT awaited, and
  // deliberately after classifyAndStoreDoc has already flipped status to 'ready'.
  // Insights must be visible the instant they exist — making the user wait on
  // another Sonnet call for a surface they have not opened yet would make every
  // upload feel slower. The panel polls and picks angles up when they land.
  // buildAnglesForDocument never throws, so this cannot surface as a rejection.
  require('../services/vaultAngles')
    .buildAnglesForDocument(docId, userId, tenantId)
    .then(count => { if (count) console.log(`[vault] doc=${docId} built ${count} angles`); });
}

// ---------------------------------------------------------------------------
// GET /api/vault/documents — list user's vault documents
// ---------------------------------------------------------------------------
router.get('/documents', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  // angle_count drives the card label ("3 post ideas · 12 insights") and the
  // default tab. It has to be on the list response, not fetched per card, or the
  // card would advertise a count the panel might not be able to honour.
  const docs = await db.prepare(`
    SELECT vd.id, vd.filename, vd.source_type, vd.source_url, vd.status, vd.chunk_count,
           vd.ideas_mined, vd.error_message, vd.created_at,
           (SELECT COUNT(*)::int FROM vault_angles va WHERE va.document_id = vd.id) AS angle_count
    FROM   vault_documents vd
    WHERE  vd.tenant_id = ?
    ORDER  BY vd.created_at DESC
  `).all(tenantId);

  return res.json({ ok: true, documents: docs });
});

// ---------------------------------------------------------------------------
// GET /api/vault/documents/count — cheap check for the dashboard's Vault nudge
// ---------------------------------------------------------------------------
router.get('/documents/count', async (req, res) => {
  if (!requireUser(req, res)) return;
  const row = await db.prepare(
    'SELECT COUNT(*) AS n FROM vault_documents WHERE tenant_id = ?'
  ).get(req.tenantId);
  return res.json({ ok: true, count: Number(row?.n || 0) });
});

// ---------------------------------------------------------------------------
// DELETE /api/vault/documents/:id — delete document (cascades chunks + ideas)
// ---------------------------------------------------------------------------
router.delete('/documents/:id', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  const { id } = req.params;

  const doc = await db.prepare(`
    SELECT id, storage_key FROM vault_documents WHERE id = ? AND tenant_id = ?
  `).get(id, tenantId);

  if (!doc) return res.status(404).json({ ok: false, error: 'document_not_found' });

  // Delete from storage (non-fatal if it fails)
  if (doc.storage_key) {
    try { await storage.delete(doc.storage_key); } catch { /* non-fatal */ }
  }

  await db.prepare('DELETE FROM vault_documents WHERE id = ?').run(id);

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/vault/mine — trigger idea mining on all ready documents
// ---------------------------------------------------------------------------
router.post('/mine', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  // Find all unmined chunks for ready/mining documents.
  // 'mining' status = server auto-mine may have crashed; this endpoint recovers them.
  const unmined = await db.prepare(`
    SELECT vc.id, vc.document_id, vc.chunk_index, vc.content, vc.source_ref,
           vd.filename
    FROM   vault_chunks vc
    JOIN   vault_documents vd ON vd.id = vc.document_id
    WHERE  vc.tenant_id = ?
      AND  vc.mined_at IS NULL
      AND  vd.status IN ('ready', 'mining')
    ORDER  BY vc.document_id, vc.chunk_index
  `).all(tenantId);

  if (unmined.length === 0) {
    return res.json({ ok: true, seeds_created: 0, message: 'No new content to mine' });
  }

  // Acknowledge immediately; mining runs async
  res.json({ ok: true, chunks_queued: unmined.length, message: 'Mining started' });

  // Group by document for better context in prompts
  const byDoc = new Map();
  for (const chunk of unmined) {
    if (!byDoc.has(chunk.document_id)) byDoc.set(chunk.document_id, { filename: chunk.filename, chunks: [] });
    byDoc.get(chunk.document_id).chunks.push(chunk);
  }

  // Fetch workspace default profile for audience-aware classification
  const userProfile = await fetchMiningProfile(tenantId) || {};

  let totalInsights = 0;

  for (const [docId, { filename, chunks }] of byDoc) {
    try {
      totalInsights += await classifyAndStoreDoc(docId, chunks, filename, userProfile, userId, tenantId);
    } catch (err) {
      console.error(`[vault/mine] doc=${docId} failed:`, err.message);
    }
  }

  console.log(`[vault/mine] user=${userId} created ${totalInsights} insights`);
});

// ---------------------------------------------------------------------------
// GET /api/vault/insights?document_id= — reusable insights for a document,
// grouped by category (for the vault knowledge-store overlay).
// ---------------------------------------------------------------------------
const INSIGHT_CATEGORY_ORDER = ['key_insight', 'strategy', 'advice', 'lesson', 'mindset_shift', 'quote'];

router.get('/insights', async (req, res) => {
  const { tenantId } = req;
  if (!requireUser(req, res)) return;

  const { document_id } = req.query;

  let sql  = `SELECT id, document_id, category, content, source_ref, created_at
              FROM   vault_insights WHERE tenant_id = ?`;
  const args = [tenantId];
  if (document_id) { sql += ` AND document_id = ?`; args.push(Number(document_id)); }
  sql += ` ORDER BY created_at DESC`;

  const rows = await db.prepare(sql).all(...args);

  // Group into { category, label, items[] } in a stable display order.
  const LABELS = {
    key_insight:   'Key Insights',
    strategy:      'Strategies',
    advice:        'Actionable Advice',
    lesson:        'Lessons Learned',
    mindset_shift: 'Mindset Shifts',
    quote:         'Memorable Quotes',
  };
  const byCat = new Map();
  for (const r of rows) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push({ id: r.id, content: r.content, source_ref: r.source_ref });
  }
  const groups = INSIGHT_CATEGORY_ORDER
    .filter(cat => byCat.has(cat))
    .map(cat => ({ category: cat, label: LABELS[cat] || cat, items: byCat.get(cat) }));

  return res.json({ ok: true, total: rows.length, groups });
});

// ---------------------------------------------------------------------------
// GET /api/vault/angles?document_id= — bundled angles for a document, with each
// role's insight resolved. Shape is what the panel renders and what the generate
// endpoint reads, so roles arrive as an ordered array rather than a bare id map.
// ---------------------------------------------------------------------------
router.get('/angles', async (req, res) => {
  const { tenantId } = req;
  if (!requireUser(req, res)) return;

  const documentId = Number(req.query.document_id);
  if (!Number.isInteger(documentId) || documentId <= 0) {
    return res.status(400).json({ ok: false, error: 'document_id_required' });
  }

  const { ROLE_ORDER } = require('../services/vaultBrief');

  const angles = await db.prepare(`
    SELECT id, title, roles, insight_ids, used_count, last_used_at
    FROM   vault_angles
    WHERE  document_id = ? AND tenant_id = ?
    ORDER  BY id ASC
  `).all(documentId, tenantId);

  if (!angles.length) return res.json({ ok: true, angles: [] });

  // One query for every insight referenced by any angle, then stitch in memory —
  // a document has ≤4 angles over ≤20 insights, so per-angle queries would be
  // pure round-trip cost.
  const allIds = [...new Set(angles.flatMap(a => (a.insight_ids || []).map(Number)))];
  const rows = allIds.length
    ? await db.prepare(`
        SELECT id, category, content, source_ref
        FROM   vault_insights
        WHERE  tenant_id = ? AND id = ANY(?)
      `).all(tenantId, allIds)
    : [];
  const byId = new Map(rows.map(r => [Number(r.id), r]));

  const shaped = angles.map(a => {
    const roleMap = typeof a.roles === 'string' ? JSON.parse(a.roles || '{}') : (a.roles || {});
    const roles = ROLE_ORDER
      .filter(role => roleMap[role] != null && byId.has(Number(roleMap[role])))
      .map(role => {
        const ins = byId.get(Number(roleMap[role]));
        return { role, insight_id: ins.id, category: ins.category, content: ins.content, source_ref: ins.source_ref };
      });
    // "includes a number" — the honest at-a-glance signal of whether the post will
    // carry a specific. Computed here so the panel does not re-derive it.
    const hasNumber = roles.some(r => /\d/.test(r.content));
    return { id: a.id, title: a.title, roles, insight_count: roles.length, has_number: hasNumber, used_count: a.used_count };
  });

  return res.json({ ok: true, angles: shaped });
});

const INSIGHT_TYPE_FALLBACK = {
  key_insight:   'trust',
  strategy:      'framework',
  advice:        'framework',
  lesson:        'lessons_learned',
  mindset_shift: 'contrarian',
  quote:         'trust',
};
// Types reachable from document material. 'announcement' is excluded (nothing in
// a document is news) and so is 'reach' (too vague to shape anything).
const INSIGHT_POST_TYPES = ['trust', 'framework', 'lessons_learned', 'contrarian', 'story', 'results', 'pis', 'bts', 'lead_gen'];
const VALID_LENGTHS = new Set(['short', 'medium', 'long']);

// Resolve an insight back to the chunk it came from. vault_insights stores only a
// display label (source_ref), not a chunk id, so this degrades through three
// strategies rather than assuming the label round-trips: the classifier is told to
// copy the bracket label verbatim, but chunk labels carry an optional " — display"
// suffix that the model sometimes includes and sometimes doesn't.
async function resolveInsightChunk(insight, tenantId) {
  const docId = insight.document_id;

  // 1. Label match — exact, or the insight's label starting with the chunk's.
  if (insight.source_ref) {
    const byRef = await db.prepare(`
      SELECT id, content, chunk_index FROM vault_chunks
      WHERE  document_id = ? AND tenant_id = ? AND source_ref IS NOT NULL
        AND  (source_ref = ? OR ? LIKE source_ref || '%')
      ORDER  BY length(source_ref) DESC, chunk_index ASC
      LIMIT  1
    `).get(docId, tenantId, insight.source_ref, insight.source_ref);
    if (byRef) return byRef;
  }

  // 2. Substring match — reliable for 'quote', whose content is verbatim.
  // Escape LIKE metacharacters — insight text is arbitrary prose and a stray '%'
  // would silently match the wrong chunk.
  const probe = String(insight.content || '').trim().slice(0, 60).replace(/[\\%_]/g, '\\$&');
  if (probe.length >= 20) {
    const byText = await db.prepare(`
      SELECT id, content, chunk_index FROM vault_chunks
      WHERE  document_id = ? AND tenant_id = ? AND content ILIKE ? ESCAPE '\\'
      ORDER  BY chunk_index ASC LIMIT 1
    `).get(docId, tenantId, `%${probe}%`);
    if (byText) return byText;
  }

  // 3. Full-text, OR-joined. plainto_tsquery ANDs every term, which a condensed
  // one-line insight almost never satisfies against its own source chunk — so
  // build an OR query from the distinctive tokens instead. Tokens are filtered
  // to [a-z0-9] before interpolation, so there is nothing left to inject.
  const tokens = String(insight.content || '')
    .toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3).slice(0, 12);
  if (tokens.length) {
    const tsq = tokens.join(' | ');
    const byFts = await db.prepare(`
      SELECT id, content, chunk_index,
             ts_rank(to_tsvector('english', content), to_tsquery('english', ?)) AS rank
      FROM   vault_chunks
      WHERE  document_id = ? AND tenant_id = ?
        AND  to_tsvector('english', content) @@ to_tsquery('english', ?)
      ORDER  BY rank DESC LIMIT 1
    `).get(tsq, docId, tenantId, tsq);
    if (byFts) return byFts;
  }

  return null;
}

// Pick the post shape from the material. Haiku, constrained to the shapes
// organizePost knows; the category map is the fallback so a failed or malformed
// classification never blocks generation.
async function selectPostType(insight, passage, apiKey) {
  const fallback = INSIGHT_TYPE_FALLBACK[insight.category] || 'trust';
  if (!apiKey) return fallback;
  try {
    const client = new (require('@anthropic-ai/sdk'))({ apiKey });
    const message = await client.messages.create({
      model:       HAIKU_MODEL,
      max_tokens:  20,
      temperature: 0,
      system:      'You classify source material into one LinkedIn post shape. Reply with one word from the list and nothing else.',
      messages: [{
        role: 'user',
        content: `Shapes:
- trust: teaches one idea or explains a non-obvious truth
- framework: a named method, system, or set of steps
- lessons_learned: a lesson drawn from an experience
- contrarian: a reframe, or a view that contradicts conventional wisdom
- story: a specific event with a turn
- results: leads with a concrete outcome or number
- pis: a problem, its real cause, and the fix
- bts: process and decisions, in the order they happened
- lead_gen: value-first with a soft next step

THE POINT: ${String(insight.content || '').slice(0, 400)}

SOURCE MATERIAL: ${String(passage || '').slice(0, 1500)}

Which shape does this material actually support? One word.`,
      }],
    });
    const raw = (message.content.find(b => b.type === 'text')?.text || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
    return INSIGHT_POST_TYPES.includes(raw) ? raw : fallback;
  } catch (err) {
    console.warn('[vault/generate] post-type classification failed, using category fallback:', err.message);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// POST /api/vault/angles/:id/generate — one angle → one synthesised post.
//
// The difference from the single-insight path is not "more material" — it is that
// the material arrives with ROLES. One insight is the claim; the others prove it,
// oppose it, or explain it. Handing a model four insights flat produces "4 lessons
// from my case study"; labelling which serves which produces an argument.
//
// Every roled insight is resolved back to its source passage, not just the spine:
// mined insights are condensed paraphrases, so a support arriving as its one-line
// form would put unmarked machine text in the brief — which retention would still
// score as faithful. See Flaw 3 in sprint-vault-angles.md.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// POST /api/vault/documents/:id/angles — (re)build a document's angles from the
// insights it already has.
//
// Needed because angle-building only ever ran as a stage of mining, so every
// document mined before it shipped has none — and with the per-insight generate
// button removed, a document with no angles has no way to produce a post at all.
// Chunks and insights are already stored, so this is one Sonnet call, not a
// re-mine. Awaited rather than fire-and-forget: the user is looking at an empty
// tab and needs to know whether it worked.
// ---------------------------------------------------------------------------
router.post('/documents/:id/angles', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  const docId = Number(req.params.id);
  if (!Number.isInteger(docId) || docId <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_document_id' });
  }

  const doc = await db.prepare('SELECT id FROM vault_documents WHERE id = ? AND tenant_id = ?').get(docId, tenantId);
  if (!doc) return res.status(404).json({ ok: false, error: 'document_not_found' });

  const { buildAnglesForDocument } = require('../services/vaultAngles');
  const count = await buildAnglesForDocument(docId, userId, tenantId);
  return res.json({ ok: true, angles: count });
});

// Load one angle with its document filename. Used by the angle route and by the
// per-insight upgrade path.
async function fetchAngle(angleId, tenantId) {
  return db.prepare(`
    SELECT va.id, va.document_id, va.title, va.roles, vd.filename
    FROM   vault_angles va
    LEFT   JOIN vault_documents vd ON vd.id = va.document_id
    WHERE  va.id = ? AND va.tenant_id = ?
  `).get(angleId, tenantId);
}

// ---------------------------------------------------------------------------
// Shared angle generation. Extracted so the per-insight path can reuse it when
// the clicked insight is an angle's spine (Phase 4) rather than duplicating the
// brief assembly, type inference, gate and insert.
// Throws with .status on caller-fixable problems; returns the new post's row.
// ---------------------------------------------------------------------------
async function generateFromAngleRow(angle, { userId, tenantId, length, profile, source }) {
    const roleMap = typeof angle.roles === 'string' ? JSON.parse(angle.roles || '{}') : (angle.roles || {});
    const { ROLE_ORDER } = require('../services/vaultBrief');
    const roleIds = ROLE_ORDER
      .filter(r => roleMap[r] != null)
      .map(r => ({ role: r, id: Number(roleMap[r]) }));
    if (!roleIds.some(r => r.role === 'spine')) throw Object.assign(new Error('angle_has_no_spine'), { status: 422 });

    const insightRows = await db.prepare(`
      SELECT id, document_id, category, content, source_ref
      FROM   vault_insights WHERE tenant_id = ? AND id = ANY(?)
    `).all(tenantId, roleIds.map(r => r.id));
    const byId = new Map(insightRows.map(r => [Number(r.id), r]));

    // Resolve a passage for EVERY role, sequentially — a handful of cheap indexed
    // lookups, and the ordering keeps the brief's blocks deterministic.
    const blocks = [];
    let spineChunk = null;
    for (const { role, id } of roleIds) {
      const ins = byId.get(id);
      if (!ins) continue;                       // insight deleted since clustering
      const chunk = await resolveInsightChunk(ins, tenantId);
      if (role === 'spine') spineChunk = chunk;
      blocks.push({
        role,
        content:   ins.content,
        passage:   chunk?.content || '',
        chunkId:   chunk?.id ?? null,
        sourceRef: ins.source_ref || null,
      });
    }
    if (!blocks.some(b => b.role === 'spine')) throw Object.assign(new Error('spine_insight_missing'), { status: 422 });

    // Neighbours for the spine only. Pulling them for every role would triple the
    // brief for context that is background by definition.
    let neighbours = '';
    if (spineChunk) {
      const rows = await db.prepare(`
        SELECT content FROM vault_chunks
        WHERE  document_id = ? AND tenant_id = ? AND chunk_index IN (?, ?)
        ORDER  BY chunk_index
      `).all(angle.document_id, tenantId, spineChunk.chunk_index - 1, spineChunk.chunk_index + 1);
      neighbours = rows.map(r => r.content).join('\n\n');
    }

    const { buildRoleBrief } = require('../services/vaultBrief');
    const brief = buildRoleBrief({ filename: angle.filename || '', blocks, neighbours });

    // Post type from the spine plus its tension — a claim and the thing it
    // contradicts is a far stronger signal than one sentence alone.
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await require('../db').getSetting('anthropic_api_key'));
    const spineBlock   = blocks.find(b => b.role === 'spine');
    const tensionBlock = blocks.find(b => b.role === 'tension');
    const typeProbe = {
      category: byId.get(Number(roleMap.spine))?.category || 'key_insight',
      content:  [angle.title, spineBlock?.content, tensionBlock && `Contradicts: ${tensionBlock.content}`].filter(Boolean).join('\n'),
    };
    const postType = await selectPostType(typeProbe, spineBlock?.passage || spineBlock?.content || '', apiKey);

    const { organizePost, ROLE_BRIEF_MAX_JOINS } = require('../services/organizePost');
    const org = await organizePost(brief, profile, {
      postType,
      lengthPreference: length,
      fromInterview:    true,
      maxJoins:         ROLE_BRIEF_MAX_JOINS,
      // The brief is a document, so EDITOR_SYSTEM's "preserve their exact words"
      // rules must be suspended — preserving a case study's phrasing preserves
      // marketing prose, not the author's voice.
      sourceIsDocument: true,
    });

    const { runQualityGate } = require('../services/qualityGate');
    const { extractAuthorRealText, classifyHookShape } = require('../services/generationCore');
    const gate = runQualityGate(org.post, {
      voiceProfile: profile, archetypeUsed: null, formatSlug: 'idea',
      path: 'idea', funnelType: postType, postType,
      authorRealText: extractAuthorRealText(brief),
    });

    const runResult = await db.prepare(`
      INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
      VALUES (?, ?, ?, ?, ?) RETURNING id
    `).run(
      userId, tenantId, source,
      JSON.stringify({ raw_idea: brief, vault_angle_id: angle.id, roles: roleMap, length }),
      JSON.stringify(org.synthesis),
    );

    const insertResult = await db.prepare(`
      INSERT INTO generated_posts
        (run_id, user_id, tenant_id, profile_id, format_slug, content, ai_content,
         quality_score, quality_flags, passed_gate, funnel_type, vault_source_ref,
         idea_input, archetype_used, source, post_type, quality_verdict)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).run(
      runResult.lastInsertRowid, userId, tenantId, profile.id, 'idea',
      org.post, org.post, gate.score, JSON.stringify(gate.flags), gate.passed_gate ? 1 : 0,
      postType, spineBlock?.sourceRef || null, brief, null, source,
      postType, gate.verdict || null,
    );
    const postId = insertResult.lastInsertRowid;

    try {
      const shape = classifyHookShape(org.post);
      Promise.resolve(db.prepare('UPDATE generated_posts SET hook_shape = ? WHERE id = ?').run(shape, postId)).catch(() => {});
    } catch { /* non-fatal */ }
    Promise.resolve(db.prepare(
      'UPDATE vault_angles SET used_count = used_count + 1, last_used_at = now() WHERE id = ? AND tenant_id = ?'
    ).run(angle.id, tenantId)).catch(() => {});
    require('../services/streak').recordStreakAction(userId, tenantId, 'generate');
    require('../services/trialEmails').scheduleTrialEvaluation(userId, tenantId);

    // grounded = how many roles reached a real passage. A low ratio means the post
    // was built largely from condensed paraphrase, which retention cannot reveal.
    const grounded = blocks.filter(b => b.passage).length;
    console.log(`[vault/angle] angle=${angle.id} src=${source} type=${postType} length=${length} roles=${blocks.length} grounded=${grounded}/${blocks.length} retention=${org.retention?.score} post=${postId}`);

    return { id: postId, post: org.post, post_type: postType, length,
             roles: blocks.map(b => b.role), grounded, retention: org.retention || null,
             // Feeds the editor's provenance bar. Without these the bar has no
             // score to show and no way to disclose a composed hook.
             generation_mode: org.synthesis?.mode || 'organize',
             hook_was_written: !!org.hookWasWritten };
}

router.post('/angles/:id/generate', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  const angleId = Number(req.params.id);
  if (!Number.isInteger(angleId) || angleId <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_angle_id' });
  }

  const length = String(req.body?.length || 'medium').toLowerCase();
  if (!VALID_LENGTHS.has(length)) {
    return res.status(400).json({ ok: false, error: 'invalid_length' });
  }

  const { canGeneratePost } = require('../services/subscription');
  const planCheck = await canGeneratePost(userId);
  if (!planCheck.allowed) {
    return res.status(403).json({
      ok: false, error: 'plan_limit_exceeded',
      plan: planCheck.plan, current: planCheck.current, limit: planCheck.limit,
    });
  }

  try {
    const angle = await fetchAngle(angleId, tenantId);
    if (!angle) return res.status(404).json({ ok: false, error: 'angle_not_found' });

    const { resolveProfile } = require('../lib/resolveProfile');
    const profile = await resolveProfile(tenantId);
    if (!profile) return res.status(400).json({ ok: false, error: 'complete_profile_first' });

    const out = await generateFromAngleRow(angle, { userId, tenantId, length, profile, source: 'vault_angle' });
    return res.json({ ok: true, ...out });
  } catch (err) {
    // Capacity errors first: they arrive from the Anthropic SDK carrying .status,
    // so a generic `if (err.status)` above this would answer 429 with the SDK's
    // own message instead of the high_demand 503 the client knows how to retry.
    if (err.status === 429 || err.status === 529) {
      return res.status(503).json({ ok: false, error: 'high_demand', retry_after_sec: 30 });
    }
    // Our own caller-fixable failures (angle_has_no_spine, spine_insight_missing).
    if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
    console.error('[vault/angle] error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'generation_failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/vault/insights/:id/generate — one insight → one finished post.
//
// The insight line itself is a condensed restatement and far too thin to write
// from. What makes this path work is that the insight is an INDEX into the
// author's own document: we resolve it back to the source passage and organise
// THAT. So generation runs through organizePost (editor, not writer) — the
// material is already the author's words, and the job is shaping, not composing.
//
// The only user-facing option is length. Post type is inferred from the material.
// ---------------------------------------------------------------------------
router.post('/insights/:id/generate', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  const insightId = Number(req.params.id);
  if (!Number.isInteger(insightId) || insightId <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_insight_id' });
  }

  const length = String(req.body?.length || 'medium').toLowerCase();
  if (!VALID_LENGTHS.has(length)) {
    return res.status(400).json({ ok: false, error: 'invalid_length' });
  }

  const { canGeneratePost } = require('../services/subscription');
  const planCheck = await canGeneratePost(userId);
  if (!planCheck.allowed) {
    return res.status(403).json({
      ok: false, error: 'plan_limit_exceeded',
      plan: planCheck.plan, current: planCheck.current, limit: planCheck.limit,
    });
  }

  try {
    const insight = await db.prepare(`
      SELECT vi.id, vi.document_id, vi.category, vi.content, vi.source_ref,
             vd.filename
      FROM   vault_insights vi
      LEFT   JOIN vault_documents vd ON vd.id = vi.document_id
      WHERE  vi.id = ? AND vi.tenant_id = ?
    `).get(insightId, tenantId);
    if (!insight) return res.status(404).json({ ok: false, error: 'insight_not_found' });

    const { resolveProfile } = require('../lib/resolveProfile');
    const profile = await resolveProfile(tenantId);
    if (!profile) return res.status(400).json({ ok: false, error: 'complete_profile_first' });

    // Phase 4 — upgrade a lone insight to its angle, but ONLY when the clicked
    // insight is that angle's SPINE.
    //
    // The sprint doc said to upgrade whenever any angle contains the insight.
    // That is wrong: if the user clicks "throughput rose 23%" and it is merely the
    // PROOF inside an angle whose claim is something else, they get a post about a
    // different subject than the one they clicked. Being surprised is not being
    // helped. Spine-only means the post is still about what they clicked — the
    // angle simply brings the tension and proof the single-insight path lacks.
    //
    // Scoped by document because angles never span documents, which also keeps
    // this on idx_vault_angles_document.
    const spineAngle = await db.prepare(`
      SELECT id FROM vault_angles
      WHERE  tenant_id = ? AND document_id = ? AND (roles->>'spine')::bigint = ?
      ORDER  BY id ASC LIMIT 1
    `).get(tenantId, insight.document_id, insightId);

    if (spineAngle) {
      const angle = await fetchAngle(Number(spineAngle.id), tenantId);
      if (angle) {
        try {
          // Distinct source so Phase 5 can separate a deliberate angle click from
          // an upgraded insight click when comparing conversion and edit distance.
          const out = await generateFromAngleRow(angle, {
            userId, tenantId, length, profile, source: 'vault_angle_via_insight',
          });
          console.log(`[vault/generate] insight=${insightId} upgraded to angle=${angle.id}`);
          return res.json({ ok: true, ...out, via_angle: angle.id });
        } catch (upgradeErr) {
          // An angle referencing a since-deleted insight must not cost the user
          // their post — fall through to the single-insight path below.
          console.warn(`[vault/generate] angle upgrade failed for insight=${insightId}, falling back:`, upgradeErr.message);
        }
      }
    }

    const chunk = await resolveInsightChunk(insight, tenantId);

    // Neighbouring chunks give the passage its before/after, which is usually
    // where the specifics live (the number is in one chunk, what it cost is in
    // the next). Same treatment the vault_ideas path already gives its seeds.
    let neighbours = '';
    if (chunk) {
      const rows = await db.prepare(`
        SELECT content FROM vault_chunks
        WHERE  document_id = ? AND tenant_id = ? AND chunk_index IN (?, ?)
        ORDER  BY chunk_index
      `).all(insight.document_id, tenantId, chunk.chunk_index - 1, chunk.chunk_index + 1);
      neighbours = rows.map(r => r.content).join('\n\n');
    }

    const docLabel = [insight.filename, insight.source_ref].filter(Boolean).join(' · ');
    // When the passage resolved, the insight is the ANGLE and the passage is the
    // material. When it didn't, the insight is all we have — say it once rather
    // than handing the editor the same sentence under two headings, which reads
    // as two sources agreeing and invites it to pad.
    const brief = chunk
      ? [
          `[The author's own words, from their document${docLabel ? ` "${docLabel}"` : ''}:]`,
          chunk.content,
          neighbours ? `\n[Surrounding context from the same document:]\n${neighbours}` : '',
          `\n---\n[The specific point this post is about:]\n${insight.content}`,
        ].filter(Boolean).join('\n')
      : `[The author's own words, from their document${docLabel ? ` "${docLabel}"` : ''}:]\n${insight.content}`;

    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await require('../db').getSetting('anthropic_api_key'));
    const postType = await selectPostType(insight, chunk?.content || insight.content, apiKey);

    const { organizePost } = require('../services/organizePost');
    const org = await organizePost(brief, profile, {
      postType, lengthPreference: length, sourceIsDocument: true,
    });

    const { runQualityGate }        = require('../services/qualityGate');
    const { extractAuthorRealText, classifyHookShape } = require('../services/generationCore');
    const gate = runQualityGate(org.post, {
      voiceProfile:   profile,
      archetypeUsed:  null,
      formatSlug:     'idea',
      path:           'idea',
      funnelType:     postType,
      postType,
      authorRealText: extractAuthorRealText(brief),
    });

    const runResult = await db.prepare(`
      INSERT INTO generation_runs (user_id, tenant_id, path, input_data, synthesis)
      VALUES (?, ?, ?, ?, ?) RETURNING id
    `).run(
      userId, tenantId, 'vault_insight',
      JSON.stringify({ raw_idea: brief, vault_insight_id: insight.id, length }),
      JSON.stringify(org.synthesis),
    );

    const insertResult = await db.prepare(`
      INSERT INTO generated_posts
        (run_id, user_id, tenant_id, profile_id, format_slug, content, ai_content,
         quality_score, quality_flags, passed_gate, funnel_type, vault_source_ref,
         idea_input, archetype_used, source, post_type, quality_verdict)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).run(
      runResult.lastInsertRowid, userId, tenantId, profile.id, 'idea',
      org.post, org.post, gate.score, JSON.stringify(gate.flags), gate.passed_gate ? 1 : 0,
      postType, insight.source_ref || null, brief, null, 'vault_insight',
      postType, gate.verdict || null,
    );
    const postId = insertResult.lastInsertRowid;

    // Fire-and-forget signals — none of these may block the response.
    try {
      const shape = classifyHookShape(org.post);
      Promise.resolve(db.prepare('UPDATE generated_posts SET hook_shape = ? WHERE id = ?').run(shape, postId)).catch(() => {});
    } catch { /* non-fatal */ }
    Promise.resolve(db.prepare(
      'UPDATE vault_insights SET used_count = used_count + 1, last_used_at = now() WHERE id = ? AND tenant_id = ?'
    ).run(insight.id, tenantId)).catch(() => {});
    require('../services/streak').recordStreakAction(userId, tenantId, 'generate');
    require('../services/trialEmails').scheduleTrialEvaluation(userId, tenantId);

    console.log(`[vault/generate] insight=${insight.id} type=${postType} length=${length} grounded=${!!chunk} retention=${org.retention?.score} post=${postId}`);

    return res.json({
      ok: true, id: postId, post: org.post, post_type: postType,
      length, grounded: !!chunk, retention: org.retention || null,
      generation_mode: org.synthesis?.mode || 'organize',
      hook_was_written: !!org.hookWasWritten,
    });
  } catch (err) {
    if (err.status === 429 || err.status === 529) {
      return res.status(503).json({ ok: false, error: 'high_demand', retry_after_sec: 30 });
    }
    console.error('[vault/generate] error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'generation_failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/vault/ideas — list ideas
// Query params: status (fresh|saved|discarded|used), funnel_type (reach|trust|convert),
//               source (mined|idea_engine), document_id
// ---------------------------------------------------------------------------
router.get('/ideas', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  const { status, funnel_type, document_id, source } = req.query;

  // chunk_id IS NOT NULL gate only applies to mined ideas; idea_engine rows have no chunk
  const sourceFilter = source === 'idea_engine'
    ? `AND source = 'idea_engine'`
    : source === 'mined'
      ? `AND (source IS NULL OR source = 'mined') AND chunk_id IS NOT NULL`
      : `AND (chunk_id IS NOT NULL OR source = 'idea_engine')`;

  let sql    = `SELECT id, document_id, seed_text, source_ref, funnel_type, hook_archetype,
                       status, generated_post_id, hook_preview, source, created_at
                FROM   vault_ideas
                WHERE  tenant_id = ?
                  ${sourceFilter}`;
  const args = [tenantId];

  if (status) {
    sql += ` AND status = ?`;
    args.push(status);
  }
  if (funnel_type) {
    sql += ` AND funnel_type = ?`;
    args.push(funnel_type);
  }
  if (document_id) {
    sql += ` AND document_id = ?`;
    args.push(Number(document_id));
  }

  sql += ` ORDER BY
    CASE funnel_type WHEN 'convert' THEN 0 WHEN 'trust' THEN 1 ELSE 2 END,
    created_at DESC`;

  const limitVal = req.query.limit ? parseInt(req.query.limit, 10) : null;
  if (limitVal && limitVal > 0) sql += ` LIMIT ${limitVal}`;

  const ideas = await db.prepare(sql).all(...args);
  return res.json({ ok: true, ideas });
});

// ---------------------------------------------------------------------------
// GET /api/vault/suggest-topics
// Returns 3 AI-suggested post topics based on the user's profile + LinkedIn headline.
// Used to populate the blank vault state with actionable starting points.
// Non-fatal: returns empty array on any failure.
// ---------------------------------------------------------------------------
router.get('/suggest-topics', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  const { post_type, exclude_topics } = req.query;
  let excluded = [];
  try { excluded = JSON.parse(exclude_topics || '[]'); if (!Array.isArray(excluded)) excluded = []; } catch { excluded = []; }

  try {
    const profile = await fetchMiningProfile(tenantId);

    const liRow = await db.prepare(
      'SELECT display_name FROM linkedin_connections WHERE workspace_id = ? AND is_default = true'
    ).get(tenantId);

    const niche       = profile?.brand_industry         || '';
    const audience    = profile?.audience_description    || '';
    const pain        = profile?.audience_obstacles      || '';
    const positioning = profile?.elevator_main_result    || '';
    const headline    = liRow?.display_name              || '';
    const contrarian  = profile?.brand_core_beliefs      || '';

    // Parse writing samples — take up to 2, cap each at 350 chars to keep prompt tight
    let writingSamples = [];
    if (profile?.input_examples) {
      try {
        const parsed = JSON.parse(profile.input_examples);
        if (Array.isArray(parsed)) {
          writingSamples = parsed
            .filter(s => typeof s === 'string' && s.trim().length > 40)
            .slice(0, 2)
            .map(s => s.trim().slice(0, 350));
        }
      } catch { /* malformed — ignore */ }
    }

    // Parse content pillars — the topic areas the user has explicitly chosen to own
    let pillars = [];
    if (profile?.content_pillars) {
      try {
        const parsed = JSON.parse(profile.content_pillars);
        if (Array.isArray(parsed)) {
          pillars = parsed.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim());
        }
      } catch { /* malformed — ignore */ }
    }

    if (!niche && !audience && !positioning && !headline && !writingSamples.length) {
      return res.json({ ok: true, topics: [] });
    }

    const Anthropic  = require('@anthropic-ai/sdk');
    const { getSetting } = require('../db');
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return res.json({ ok: true, topics: [] });

    const client = new Anthropic({ apiKey });

    const samplesBlock = writingSamples.length
      ? `\nWriting samples (their actual posts — use these to understand their natural topics, tone, and vocabulary):\n${writingSamples.map((s, i) => `[${i + 1}] "${s}"`).join('\n')}`
      : '';

    const pillarsBlock = pillars.length
      ? `\nContent pillars (the strategic topic areas they have chosen to own — ideas MUST stay within these):\n${pillars.map(p => `- ${p}`).join('\n')}`
      : '';

    const context = [
      niche       && `Niche: ${niche}`,
      audience    && `Audience: ${audience}`,
      pain        && `Their main challenge: ${pain}`,
      positioning && `Positioning: ${positioning}`,
      headline    && `LinkedIn headline: ${headline}`,
      contrarian  && `Their contrarian POV: ${contrarian}`,
    ].filter(Boolean).join('\n') + pillarsBlock + samplesBlock;

    const TYPE_GUIDANCE = {
      reach: `Goal: REACH (grow audience)\nFocus: relatable stories, personal contradictions, lessons learned the hard way, before/after moments. Topics that make strangers feel seen and want to share.`,
      trust: `Goal: TRUST (build authority)\nFocus: non-obvious insights, contrarian positions, expertise demonstrations, industry myths busted. Topics that make readers think "I've never heard it put that way."`,
      convert: `Goal: CONVERT (drive leads)\nFocus: outcome-first hooks, specific client results, problem-solution frames, "here's what actually works" angles. Topics that make ideal buyers lean in.`,
      lead_magnet: `Goal: LEAD MAGNET (grow DM list)\nFocus: free resource ideas, system giveaways, checklists, frameworks, templates this person could credibly offer. Topics that position a specific deliverable.`,
    };

    const typeGuidanceBlock = TYPE_GUIDANCE[post_type]
      ? `\nPOST TYPE CONTEXT:\n${TYPE_GUIDANCE[post_type]}\nBias your 3 topics toward this goal.\n`
      : '';

    const message = await client.messages.create({
      model:      SONNET_MODEL,
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: `Generate 3 specific LinkedIn post topics for this professional.

${context}
${typeGuidanceBlock}
${excluded.length ? `Do NOT suggest any of these previously shown topics:\n${excluded.map(t => `- ${t}`).join('\n')}\n` : ''}Each topic must:
- Be a concrete, opinionated premise — not a generic category
- Reflect a real tension, lesson, or contrarian view specific to their niche
- Feel like something only this person could write
${pillars.length ? '- Stay anchored within their content pillars — do not suggest topics outside these strategic areas' : ''}${writingSamples.length ? '\n- Mirror the vocabulary, topic territory, and level of specificity shown in their writing samples — not copying them, but extending naturally from them' : ''}

For each topic also write a "textarea_input": 2–3 sentences in FIRST PERSON that this author would type as their raw starting material. It should sound like they're briefing a ghostwriter — personal, specific, with at least one concrete detail (number, timeframe, named situation). NOT a drafted post.

Return ONLY a JSON array of 3 objects, no other text:
[
  {
    "title": "3-7 word opinionated topic",
    "description": "One sentence explaining the angle or tension",
    "textarea_input": "2-3 sentence first-person raw input the author would type"
  },
  ...
]`,
      }],
    });

    const raw = message.content[0]?.text || '[]';
    let topics = [];
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      topics = JSON.parse(match ? match[0] : raw);
      if (!Array.isArray(topics)) topics = [];
      topics = topics
        .filter(t => t && typeof t.title === 'string' && typeof t.description === 'string')
        .slice(0, 3);
    } catch { /* return empty on parse failure */ }

    return res.json({ ok: true, topics });
  } catch (err) {
    console.error('[vault/suggest-topics] error (non-fatal):', err.message);
    return res.json({ ok: true, topics: [] });
  }
});

// ---------------------------------------------------------------------------
// GET /api/vault/generate-ideas
// Returns 6 strong, ICP-matched post ideas combining voice DNA, vault anchors,
// and LLM world knowledge of what performs in the user's niche.
// Non-fatal: returns empty array on any failure.
// ---------------------------------------------------------------------------
router.get('/generate-ideas', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  const { post_type, exclude_hooks } = req.query;
  let excludedHooks = [];
  try {
    excludedHooks = JSON.parse(exclude_hooks || '[]');
    if (!Array.isArray(excludedHooks)) excludedHooks = [];
  } catch { excludedHooks = []; }
  excludedHooks = excludedHooks.slice(-12);

  try {
    const profile = await fetchMiningProfile(tenantId);

    const liRow = await db.prepare(
      'SELECT display_name FROM linkedin_connections WHERE workspace_id = ? AND is_default = true'
    ).get(tenantId);

    const niche    = profile?.brand_industry         || '';
    const audience = profile?.audience_description    || '';
    const pain     = profile?.audience_obstacles      || '';

    // Parse voice_fingerprint for deep ICP signals
    let fp = {};
    try { fp = JSON.parse(profile?.voice_fingerprint || '{}') || {}; } catch { fp = {}; }
    const pos = fp.positioning || {};

    // Parse content pillars
    let pillars = [];
    try {
      const p = JSON.parse(profile?.content_pillars || '[]');
      if (Array.isArray(p)) pillars = p.filter(x => typeof x === 'string' && x.trim()).slice(0, 4);
    } catch { pillars = []; }

    // Parse authority statements
    let authStatements = [];
    try {
      const a = JSON.parse(profile?.authority_statements || '[]');
      if (Array.isArray(a)) authStatements = a.filter(x => typeof x === 'string' && x.trim()).slice(0, 2);
    } catch { authStatements = []; }

    // Parse brand personality traits
    let personalityTraits = [];
    try {
      const t = JSON.parse(profile?.brand_personality_traits || '[]');
      if (Array.isArray(t)) personalityTraits = t.filter(x => typeof x === 'string' && x.trim()).slice(0, 4);
    } catch { personalityTraits = []; }

    // Parse brand phrases to use
    let phrases = [];
    try {
      const ph = JSON.parse(profile?.brand_phrases_to_use || '[]');
      if (Array.isArray(ph)) phrases = ph.filter(x => typeof x === 'string' && x.trim()).slice(0, 5);
    } catch { phrases = []; }

    // Parse audience goals
    let audienceGoals = [];
    try {
      const g = JSON.parse(profile?.audience_goals || '[]');
      if (Array.isArray(g)) audienceGoals = g.filter(x => typeof x === 'string' && x.trim()).slice(0, 3);
    } catch { audienceGoals = []; }

    // Parse audience market beliefs (myths the audience holds — gold for trust posts)
    let audienceBeliefs = [];
    try {
      const b = JSON.parse(profile?.audience_core_beliefs_market || '[]');
      if (Array.isArray(b)) audienceBeliefs = b.filter(x => typeof x === 'string' && x.trim()).slice(0, 4);
    } catch { audienceBeliefs = []; }

    // Archetype → tension type preference map
    const ARCHETYPE_TENSION = {
      'Rebel':     'myth_bust, contrarian',
      'Outlaw':    'myth_bust, contrarian',
      'Sage':      'contrarian, prediction',
      'Expert':    'contrarian, prediction',
      'Mentor':    'lesson_learned, behind_scenes',
      'Teacher':   'lesson_learned, behind_scenes',
      'Hero':      'outcome_proof, lesson_learned',
      'Leader':    'outcome_proof, contrarian',
      'Explorer':  'prediction, behind_scenes',
      'Innovator': 'prediction, contrarian',
      'Creator':   'behind_scenes, lesson_learned',
      'Builder':   'behind_scenes, lesson_learned',
      'Caregiver': 'lesson_learned, behind_scenes',
      'Everyman':  'lesson_learned, outcome_proof',
    };
    const archetype = profile?.brand_archetype || '';
    const preferredTensionTypes = archetype ? (ARCHETYPE_TENSION[archetype] || null) : null;

    // Guard: require minimum viable ICP
    if (!niche && !audience && !pos.stands_for && !profile?.brand_description) {
      return res.json({ ok: true, ideas: [], icp_summary: '' });
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const { getSetting } = require('../db');
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return res.json({ ok: true, ideas: [], icp_summary: '' });

    const client = new Anthropic({ apiKey });

    // WHO THEY ARE — brand_description as first anchor, clearest single-sentence identity
    const icpLines = [
      profile?.brand_description    && `What they do: ${profile.brand_description}`,
      niche                         && `Industry/niche: ${niche}`,
      profile?.elevator_main_result && `Core outcome they deliver: ${profile.elevator_main_result}`,
      pos.stands_for                && `What they stand for: ${pos.stands_for}`,
      pos.pushes_back_against       && `What they push back against: ${pos.pushes_back_against}`,
      pos.outcome                   && `Transformation they create: ${pos.outcome}`,
      profile?.brand_core_beliefs   && `Their non-negotiable beliefs: ${profile.brand_core_beliefs}`,
      pillars.length                && `Strategic pillars: ${pillars.join(' | ')}`,
      liRow?.display_name           && `LinkedIn name: ${liRow.display_name}`,
    ].filter(Boolean).join('\n');

    const authBlock = authStatements.length
      ? `\nProof points:\n${authStatements.map(s => `- ${s}`).join('\n')}`
      : '';

    // THEIR VOICE — archetype with hardcoded tension preferences + personality + owned vocabulary
    const voiceBlock = [
      archetype              && `Brand archetype: ${archetype}`,
      preferredTensionTypes  && `Preferred tension types for this archetype: ${preferredTensionTypes}`,
      personalityTraits.length && `Communication style: ${personalityTraits.join(', ')}`,
      phrases.length         && `Owned vocabulary (use naturally in story_prompt): ${phrases.join(', ')}`,
    ].filter(Boolean).join('\n');

    // THEIR AUDIENCE — goals alongside obstacles + market beliefs (the myths they hold)
    const audienceBlock = [
      audience                 && `Who they are: ${audience}`,
      audienceGoals.length     && `What they want to achieve:\n${audienceGoals.map(g => `- ${g}`).join('\n')}`,
      pain                     && `What's blocking them: ${pain}`,
      audienceBeliefs.length   && `What they currently believe (market assumptions):\n${audienceBeliefs.map(b => `- ${b}`).join('\n')}`,
    ].filter(Boolean).join('\n');

    // Post type directive
    const TYPE_DIRECTIVE = {
      reach:   'All 3 ideas should be REACH type — relatable stories, personal contradictions, before/after moments that make strangers feel seen.',
      trust:   'All 3 ideas should be TRUST type — non-obvious insights, contrarian positions, expertise demonstrations that make readers think "I\'ve never heard it put that way."',
      convert: 'All 3 ideas should be CONVERT type — outcome-first hooks, specific client results, problem-solution frames that make ideal buyers lean in.',
    };
    const postTypeDirective = TYPE_DIRECTIVE[post_type]
      || 'One idea should be REACH (relatable story), one TRUST (contrarian expertise), one CONVERT (outcome-proof). Choose the strongest possible angle for each.';

    const excludeBlock = excludedHooks.length
      ? `\nAVOID these angles (already shown):\n${excludedHooks.map(h => `- ${h}`).join('\n')}\n`
      : '';

    const prompt = `You are a world-class LinkedIn content strategist. Generate 3 genuinely strong post ideas — not generic topics, but specific angles only THIS creator can own.

== WHO THEY ARE ==
${icpLines}${authBlock}

== THEIR VOICE ==
${voiceBlock || '(no voice data — use a confident, direct professional tone)'}

== THEIR AUDIENCE ==
${audienceBlock || `Professionals who want to grow in the ${niche || 'their'} space.`}
They follow this creator because ${pos.stands_for || 'they have a unique perspective'}.

== YOUR TASK ==
Step 1 — Find the tensions: What are the 3–4 most painful gaps between what this audience WANTS and what is currently STOPPING them in the ${niche || 'professional'} space? What counterintuitive truths would make them say "I've never heard it framed that way"?

Step 2 — Find the collisions: Look for places where the AUDIENCE'S market beliefs (listed above) clash with THIS CREATOR'S beliefs. Those collisions are precision TRUST post angles — don't invent myths, use the ones already listed. For each tension, ask: what is this specific creator's UNIQUE take, given their archetype and positioning? Generic observations get ignored.

Step 3 — Generate exactly 3 ideas. ${postTypeDirective}${preferredTensionTypes ? `\nThis creator's archetype is ${archetype} — lean toward tension types: ${preferredTensionTypes}.` : ''}

For each idea, write a "story_prompt" — NOT the post itself. A 4–5 sentence first-person brief the creator would hand to a ghostwriter. It must:
- Open with a specific moment, situation, or realisation (not a generic statement)
- Name a concrete tension the creator personally observed or experienced
- Include a prompt for a specific detail: a number, timeframe, client result, or named example to fill in
- End with the insight or shift — what changed, what they now believe${personalityTraits.length ? `\n- Sound like someone who is ${personalityTraits.join(', ')}` : ''}${phrases.length ? `\n- Use their owned vocabulary naturally where it fits: ${phrases.join(', ')}` : ''}

The story_prompt is the fuel that makes the generated post specific and real. Make it rich.
${excludeBlock}
Return ONLY a JSON array of 3 objects, no other text:
[
  {
    "hook": "8-12 word arresting opening line — specific, opinionated, no filler, no 'I' as first word",
    "angle": "One crisp sentence: the exact tension or contrarian point",
    "icp_resonance": "One sentence: the specific pain point, goal gap, or belief clash this addresses",
    "post_type": "reach | trust | convert",
    "tension_type": "lesson_learned | contrarian | outcome_proof | myth_bust | behind_scenes | prediction",
    "story_prompt": "4-5 sentence first-person brief with a specific moment, named tension, detail prompt, and the insight"
  }
]`;

    const message = await client.messages.create({
      model:      SONNET_MODEL,
      max_tokens: 1600,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content[0]?.text || '[]';
    let ideas = [];
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      ideas = JSON.parse(match ? match[0] : raw);
      if (!Array.isArray(ideas)) ideas = [];
      ideas = ideas
        .filter(i => i && typeof i.hook === 'string' && typeof i.angle === 'string')
        .slice(0, 3);
    } catch { /* return empty on parse failure */ }

    // Persist ideas to vault_ideas so they survive the session.
    // seed_text stores the full idea JSON so brief-idea can reconstruct story_prompt.
    const insertStmt = db.prepare(`
      INSERT INTO vault_ideas (user_id, tenant_id, seed_text, source_ref, funnel_type,
                               hook_archetype, hook_preview, source, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'idea_engine', 'fresh')
    `);
    const ideasWithIds = ideas.map(idea => {
      try {
        const row = insertStmt.run(
          userId, tenantId,
          JSON.stringify({ hook: idea.hook, angle: idea.angle, story_prompt: idea.story_prompt || '' }),
          idea.icp_resonance || null,
          idea.post_type     || null,
          idea.tension_type  || null,
          idea.hook          || null,
        );
        return { ...idea, id: Number(row.lastInsertRowid) };
      } catch { return { ...idea, id: null }; }
    });

    const icpSummary = [audience, niche ? `in ${niche}` : ''].filter(Boolean).join(' ');
    return res.json({ ok: true, ideas: ideasWithIds, icp_summary: icpSummary });

  } catch (err) {
    console.error('[vault/generate-ideas] error (non-fatal):', err.message);
    return res.json({ ok: true, ideas: [], icp_summary: '' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/vault/brief-idea?id=<vault_idea_id>
// Expands an idea-engine idea into a rich first-person post brief via Haiku.
// The brief is what fills the textarea — giving the generation stage real material.
// Non-fatal: falls back to story_prompt or hook+angle if anything fails.
// ---------------------------------------------------------------------------
router.get('/brief-idea', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  const { id } = req.query;
  if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });

  try {
    const row = await db.prepare(`
      SELECT seed_text, source_ref, funnel_type, hook_preview, hook_archetype
      FROM   vault_ideas
      WHERE  id = ? AND tenant_id = ?
    `).get(id, tenantId);

    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });

    // Parse stored idea JSON
    let ideaData = {};
    try { ideaData = JSON.parse(row.seed_text); } catch {
      // Legacy plain-text seed — fall back gracefully
      ideaData = { hook: row.hook_preview || '', angle: row.seed_text, story_prompt: '' };
    }

    const { hook = '', angle = '', story_prompt = '' } = ideaData;

    // If story_prompt is already rich, return it directly without a Haiku call
    if (story_prompt && story_prompt.trim().length > 120) {
      return res.json({ ok: true, brief: story_prompt.trim() });
    }

    // Fetch workspace default profile for voice context
    const profile = await fetchMiningProfile(tenantId);

    const niche    = profile?.brand_industry         || '';
    const audience = profile?.audience_description    || '';
    const voiceSample = profile?.onboarding_q2 || '';
    let fp = {};
    try { fp = JSON.parse(profile?.voice_fingerprint || '{}'); } catch {}
    const pos = fp.positioning || {};

    const Anthropic   = require('@anthropic-ai/sdk');
    const { getSetting } = require('../db');
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return res.json({ ok: true, brief: story_prompt || `${hook}\n\n${angle}` });

    const client = new Anthropic({ apiKey });

    const prompt = `You are ghostwriting a LinkedIn post brief for a ${niche || 'professional'} creator.

CREATOR CONTEXT:
- Niche: ${niche}
- Audience: ${audience}
- Stands for: ${pos.stands_for || ''}
- Contrarian belief: ${profile?.brand_core_beliefs || ''}
${voiceSample ? `- Their natural voice (from an interview): "${voiceSample.slice(0, 300)}"` : ''}

POST IDEA:
Hook: ${hook}
Angle: ${angle}
Post type: ${row.funnel_type || 'reach'}
${story_prompt ? `Story direction: ${story_prompt}` : ''}

TASK: Write a 5-6 sentence first-person brief that this creator would use as raw material for the post. This is NOT the post — it is the brief that fuels the post.

The brief must:
1. Open with a specific scene or moment — a situation they observed, a client conversation, a realisation they had (invent a plausible specific scenario in their niche)
2. Name the tension concretely — not abstractly
3. Include at least one bracketed prompt for a specific detail they should fill in: [number], [timeframe], [client result], or [example name]
4. Show the before/after or the contradiction clearly
5. End with the core insight — what they now believe because of this

Write in casual first person. Sound like a professional talking to a ghostwriter, not writing a post. No formatting, no headers — just the brief as flowing text.

Reply with ONLY the brief text, nothing else.`;

    const message = await client.messages.create({
      model:      HAIKU_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const brief = (message.content[0]?.text || '').trim();
    return res.json({ ok: true, brief: brief || story_prompt || `${hook}\n\n${angle}` });

  } catch (err) {
    console.error('[vault/brief-idea] error (non-fatal):', err.message);
    // Graceful fallback — return story_prompt or hook+angle
    return res.json({ ok: true, brief: '' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/vault/expand-idea — turn a vault idea seed into a rich textarea input
// Query params: id (vault idea id), post_type
// ---------------------------------------------------------------------------
router.get('/expand-idea', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  const { id, post_type } = req.query;
  if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });

  try {
    const idea = db.prepare(`
      SELECT vi.id, vi.seed_text, vi.hook_archetype, vi.source_ref,
             vc.content AS chunk_content, vc.source_ref AS chunk_source_ref
      FROM   vault_ideas  vi
      LEFT JOIN vault_chunks vc ON vc.id = vi.chunk_id
      WHERE  vi.id = ? AND vi.tenant_id = ?
    `).get(id, tenantId);

    if (!idea) return res.status(404).json({ ok: false, error: 'not_found' });

    const profile = await fetchMiningProfile(tenantId);

    const niche      = profile?.brand_industry         || '';
    const audience   = profile?.audience_description    || '';
    const contrarian = profile?.brand_core_beliefs      || '';
    const voiceQ2    = profile?.onboarding_q2           || '';

    const TYPE_GUIDANCE = {
      reach:   'REACH (story/lesson): relatable moment, before/after, personal lesson learned the hard way',
      trust:   'AUTHORITY (insight): contrarian position, non-obvious expertise, industry myth busted',
      convert: 'CONVERSION (result): specific client outcome, problem → solution, outcome-first',
    };
    const guidance = TYPE_GUIDANCE[post_type] || TYPE_GUIDANCE.reach;

    const profileBlock = [
      niche      && `Niche: ${niche}`,
      audience   && `Audience: ${audience}`,
      contrarian && `Their contrarian POV: ${contrarian}`,
      voiceQ2    && `How they describe their work (voice sample): "${voiceQ2.slice(0, 180)}"`,
    ].filter(Boolean).join('\n');

    const chunkContent = (idea.chunk_content || '').slice(0, 1400);

    // Brainstormed ideas have no source chunk — return seed_text directly.
    // There is no document material to pull specifics from, and the seed is
    // already first-person, so an expansion call adds nothing here.
    if (!chunkContent) {
      return res.json({ ok: true, expanded_input: idea.seed_text });
    }

    const sourceLabel  = idea.chunk_source_ref || idea.source_ref || 'their document';

    const Anthropic = require('@anthropic-ai/sdk');
    const { getSetting } = require('../db');
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return res.json({ ok: true, expanded_input: idea.seed_text });

    const client  = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model:      HAIKU_MODEL,
      max_tokens: 280,
      messages: [{
        role: 'user',
        content: `${profileBlock ? profileBlock + '\n\n' : ''}POST TYPE: ${guidance}

VAULT MATERIAL (${sourceLabel}):
${chunkContent}

IDEA SEED: ${idea.seed_text}

Write 3–4 sentences in first person that this author would type as their raw starting material for a LinkedIn post. Requirements:
- First-person voice ("I", "my", "we")
- Include at least one specific number, timeframe, or named outcome pulled directly from the vault content
- State the central tension or contrarian point from the seed
- Raw and personal — NOT a drafted post, NOT a summary. Think: what would they tell a ghostwriter?

Reply with ONLY the expanded input text. No intro, no formatting.`,
      }],
    });

    const expanded = message.content[0]?.text?.trim() || idea.seed_text;
    return res.json({ ok: true, expanded_input: expanded });

  } catch (err) {
    console.error('[vault/expand-idea] error (non-fatal):', err.message);
    return res.json({ ok: false, error: 'expansion_failed' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/vault/ideas/:id — update idea status
// Body: { status: 'saved' | 'discarded' | 'fresh' }
// ---------------------------------------------------------------------------
router.patch('/ideas/:id', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  const { id } = req.params;
  const { status } = req.body || {};
  const VALID = ['fresh', 'saved', 'discarded'];
  if (!VALID.includes(status)) {
    return res.status(400).json({ ok: false, error: 'invalid_status', valid: VALID });
  }

  const idea = await db.prepare(`
    SELECT id FROM vault_ideas WHERE id = ? AND tenant_id = ?
  `).get(id, tenantId);
  if (!idea) return res.status(404).json({ ok: false, error: 'idea_not_found' });

  await db.prepare(`UPDATE vault_ideas SET status = ? WHERE id = ?`).run(status, id);
  return res.json({ ok: true });
});

module.exports = router;

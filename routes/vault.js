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
const { extractAndChunk, extractAndChunkUrl, mineChunks } = require('../services/vaultMiner');
const { classifyContent } = require('../services/funnelClassifier');
const { canUploadVaultDoc } = require('../services/subscription');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const ALLOWED_MIME = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/plain']);
const MIME_TO_TYPE = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
};
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

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

    const filename = parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname : '');

    // Create the document record immediately (pending)
    const docResult = await db.prepare(`
      INSERT INTO vault_documents (user_id, tenant_id, filename, source_type, source_url, status)
      VALUES (?, ?, ?, 'url', ?, 'indexing')
      RETURNING id
    `).run(userId, tenantId, filename.slice(0, 200), url);
    const docId = docResult.lastInsertRowid;

    // Process asynchronously so the HTTP response returns immediately
    setImmediate(() => processUrl(docId, url, filename, userId, tenantId));

    return res.json({ ok: true, document: { id: docId, filename, source_type: 'url', status: 'indexing' } });
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
    const storageKey  = storage.buildKey(tenantId, userId, 'vault', filename);

    // Upload to storage first
    try {
      await storage.upload(storageKey, req.body, mimeType);
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
  }
}

// ── Async processing: url ─────────────────────────────────────────────────────
async function processUrl(docId, url, filename, userId, tenantId) {
  try {
    const chunks = await extractAndChunkUrl(url);
    await saveChunks(docId, chunks, userId, tenantId);
  } catch (err) {
    console.error(`[vault] processUrl failed doc=${docId}:`, err.message);
    await db.prepare(`
      UPDATE vault_documents SET status = 'error', error_message = ?, updated_at = now() WHERE id = ?
    `).run(err.message.slice(0, 500), docId);
  }
}


// ── Save chunks to DB and mark document ready ─────────────────────────────────
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

  await db.prepare(`
    UPDATE vault_documents SET status = 'ready', chunk_count = ?, updated_at = now() WHERE id = ?
  `).run(chunks.length, docId);

  console.log(`[vault] doc=${docId} indexed ${chunks.length} chunks`);
}

// ---------------------------------------------------------------------------
// GET /api/vault/documents — list user's vault documents
// ---------------------------------------------------------------------------
router.get('/documents', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  const docs = await db.prepare(`
    SELECT id, filename, source_type, source_url, status, chunk_count, ideas_mined, error_message, created_at
    FROM   vault_documents
    WHERE  user_id = ? AND tenant_id = ?
    ORDER  BY created_at DESC
  `).all(userId, tenantId);

  return res.json({ ok: true, documents: docs });
});

// ---------------------------------------------------------------------------
// DELETE /api/vault/documents/:id — delete document (cascades chunks + ideas)
// ---------------------------------------------------------------------------
router.delete('/documents/:id', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  const { id } = req.params;

  const doc = await db.prepare(`
    SELECT id, storage_key FROM vault_documents WHERE id = ? AND user_id = ? AND tenant_id = ?
  `).get(id, userId, tenantId);

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

  // Find all unmined chunks for this user's ready documents
  const unmined = await db.prepare(`
    SELECT vc.id, vc.document_id, vc.chunk_index, vc.content, vc.source_ref,
           vd.filename
    FROM   vault_chunks vc
    JOIN   vault_documents vd ON vd.id = vc.document_id
    WHERE  vc.user_id = ? AND vc.tenant_id = ?
      AND  vc.mined_at IS NULL
      AND  vd.status = 'ready'
    ORDER  BY vc.document_id, vc.chunk_index
  `).all(userId, tenantId);

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

  // Fetch user profile once for audience-aware mining
  const userProfile = await db.prepare(
    'SELECT content_niche, audience_role, audience_pain, contrarian_view FROM user_profiles WHERE user_id = ? AND tenant_id = ?'
  ).get(userId, tenantId) || {};

  let totalSeeds = 0;

  for (const [docId, { filename, chunks }] of byDoc) {
    try {
      const seeds = await mineChunks(chunks, filename, userProfile);

      for (const seed of seeds) {
        const { funnelType, hookArchetype } = await classifyContent(seed.seed_text);

        const docFilename = filename.length > 60 ? filename.slice(0, 57) + '…' : filename;
        const sourceRef   = `From: "${docFilename}" · ${seed.source_ref}`;

        // hook_line extracted during mining — store directly as hook_preview (no separate Haiku call needed)
        await db.prepare(`
          INSERT INTO vault_ideas
            (user_id, tenant_id, document_id, chunk_id, seed_text, source_ref, funnel_type, hook_archetype, hook_preview)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(userId, tenantId, docId, seed.chunkId, seed.seed_text, sourceRef, funnelType, hookArchetype, seed.hook_line || null);

        totalSeeds++;
      }

      // Mark all chunks in this doc as mined
      const chunkIds = chunks.map(c => c.id);
      for (const cid of chunkIds) {
        await db.prepare('UPDATE vault_chunks SET mined_at = now() WHERE id = ?').run(cid);
      }

      // Update ideas_mined count on document
      await db.prepare(`
        UPDATE vault_documents SET ideas_mined = ideas_mined + ?, updated_at = now() WHERE id = ?
      `).run(seeds.length, docId);

    } catch (err) {
      console.error(`[vault/mine] doc=${docId} failed:`, err.message);
    }
  }

  console.log(`[vault/mine] user=${userId} created ${totalSeeds} seeds`);
});

// ---------------------------------------------------------------------------
// GET /api/vault/ideas — list ideas
// Query params: status (fresh|saved|discarded|used), funnel_type (reach|trust|convert)
// ---------------------------------------------------------------------------
router.get('/ideas', async (req, res) => {
  const { userId, tenantId } = req;
  if (!requireUser(req, res)) return;

  const { status, funnel_type, document_id } = req.query;

  let sql    = `SELECT id, document_id, seed_text, source_ref, funnel_type, hook_archetype,
                       status, generated_post_id, hook_preview, created_at
                FROM   vault_ideas
                WHERE  user_id = ? AND tenant_id = ?
                  AND  chunk_id IS NOT NULL`;
  const args = [userId, tenantId];

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

  const { post_type } = req.query;

  try {
    const profile = await db.prepare(
      `SELECT content_niche, audience_role, business_positioning, contrarian_view
       FROM user_profiles WHERE user_id = ? AND tenant_id = ?`
    ).get(userId, tenantId);

    const liRow = await db.prepare(
      'SELECT linkedin_headline FROM linkedin_tokens WHERE user_id = ? AND tenant_id = ?'
    ).get(userId, tenantId);

    const niche       = profile?.content_niche        || '';
    const audience    = profile?.audience_role         || '';
    const positioning = profile?.business_positioning  || '';
    const headline    = liRow?.linkedin_headline        || '';
    const contrarian  = profile?.contrarian_view       || '';

    if (!niche && !audience && !positioning && !headline) {
      return res.json({ ok: true, topics: [] });
    }

    const Anthropic  = require('@anthropic-ai/sdk');
    const { getSetting } = require('../db');
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) return res.json({ ok: true, topics: [] });

    const client = new Anthropic({ apiKey });

    const context = [
      niche       && `Niche: ${niche}`,
      audience    && `Audience: ${audience}`,
      positioning && `Positioning: ${positioning}`,
      headline    && `LinkedIn headline: ${headline}`,
      contrarian  && `Their contrarian POV: ${contrarian}`,
    ].filter(Boolean).join('\n');

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
      model:      HAIKU_MODEL,
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: `Generate 3 specific LinkedIn post topics for this professional.

${context}
${typeGuidanceBlock}
Each topic must:
- Be a concrete, opinionated premise — not a generic category
- Reflect a real tension, lesson, or contrarian view specific to their niche
- Feel like something only this person could write

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
      WHERE  vi.id = ? AND vi.user_id = ? AND vi.tenant_id = ?
    `).get(id, userId, tenantId);

    if (!idea) return res.status(404).json({ ok: false, error: 'not_found' });

    const profile = db.prepare(
      `SELECT content_niche, audience_role, audience_pain, contrarian_view, onboarding_q2
       FROM   user_profiles WHERE user_id = ? AND tenant_id = ?`
    ).get(userId, tenantId);

    const niche      = profile?.content_niche    || '';
    const audience   = profile?.audience_role    || '';
    const contrarian = profile?.contrarian_view  || '';
    const voiceQ2    = profile?.onboarding_q2    || '';

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
    SELECT id FROM vault_ideas WHERE id = ? AND user_id = ? AND tenant_id = ?
  `).get(id, userId, tenantId);
  if (!idea) return res.status(404).json({ ok: false, error: 'idea_not_found' });

  await db.prepare(`UPDATE vault_ideas SET status = ? WHERE id = ?`).run(status, id);
  return res.json({ ok: true });
});

module.exports = router;

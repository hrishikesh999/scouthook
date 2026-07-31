'use strict';

/**
 * services/vaultAngles.js — cluster a document's mined insights into angles.
 *
 * Phase 1 of sprint-vault-angles.md. An angle is a CLAIM plus role-assigned
 * material serving it: spine (the claim), tension (what it contradicts), proof
 * (the specific), mechanism (why it works), consequence (what to do).
 *
 * Why an LLM pass rather than a similarity heuristic: "which of these thirty
 * insights form an argument together, and what job does each one do" is a
 * semantic question. Token overlap finds insights that share vocabulary, which is
 * mostly how you find RESTATEMENTS of the same point — the opposite of what an
 * angle needs. A model reading all of them at once groups by thread.
 *
 * Runs AFTER vault_documents.status flips to 'ready'. Insights must appear the
 * moment they exist; holding that behind another Sonnet call makes upload feel
 * slower for a feature the user has not asked for yet.
 */

const Anthropic = require('@anthropic-ai/sdk');

// `../db` throws at require-time without DATABASE_URL, which would make the pure
// validators below unimportable in a unit test. They are the layer that has to
// survive a model returning plausible nonsense, so they must be testable without
// infrastructure — the db handle is required inside buildAnglesForDocument instead.
const SONNET_MODEL = 'claude-sonnet-4-6';

// Below this there is nothing to bundle — an angle needs a spine plus at least
// one other role, and two insights that happen to be adjacent are not an argument.
const MIN_INSIGHTS = 3;

// Product cap, not a material one. A 10-page case study yields 12-25 insights and
// 5-10 possible spines, so this binds well before the material runs out. The
// reason is the Idea Engine's record: 975 cards produced 9 posts. A document
// offering twelve angles is that failure with better typography — every weak card
// spends credibility the good one needs.
const MAX_ANGLES = 4;

const SUPPORT_ROLES = ['tension', 'proof', 'mechanism', 'consequence'];

const ANGLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['angles'],
  properties: {
    angles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'spine', 'tension', 'proof', 'mechanism', 'consequence'],
        properties: {
          title:       { type: 'string' },
          spine:       { type: 'integer' },
          // Nullable rather than optional: json_schema has no partial-object
          // support, and an explicit null is easier to validate than an absent key.
          tension:     { type: ['integer', 'null'] },
          proof:       { type: ['integer', 'null'] },
          mechanism:   { type: ['integer', 'null'] },
          consequence: { type: ['integer', 'null'] },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are finding the ARGUMENTS buried in a professional's own document, so each one can become a LinkedIn post.

You are given that document's mined insights, each with an id, a category, and where in the document it came from.

WHAT AN ANGLE IS
An angle is ONE CLAIM plus the material that serves it. It is not a group of related insights, and it is not a summary. Assign each insight you use a job:

- spine       — the single claim the post makes. REQUIRED.
- tension     — the belief or assumption this claim contradicts.
- proof       — the specific that backs it: a number, a named outcome, a concrete case.
- mechanism   — why it works, or what actually caused it.
- consequence — what someone should do differently as a result.

A post built from a claim plus its tension plus a number is deep. A post that touches four unrelated insights is "4 lessons from my case study" — the most forgettable thing on the platform. You are building the first kind.

RULES
1. Every angle needs a spine AND at least one other role filled. A spine on its own is not an angle — leave it out entirely.
2. NEVER reuse a spine. Two angles with the same claim are the same post.
3. A support MAY be reused across angles if it genuinely serves both. One strong number can prove two different claims.
4. Prefer supports from a DIFFERENT part of the document than the spine. An insight sitting right next to the spine usually just restates it and adds nothing; one from elsewhere that still bears on it is a real second data point.
5. The title must be A CLAIM SOMEONE COULD DISAGREE WITH, not a topic. "Legacy systems fail at integration, not capacity" — not "Legacy systems" or "Thoughts on modernisation". If your title could head a Wikipedia section, it is a topic; rewrite it.
6. Leave a role null when nothing genuinely fills it. A wrong proof is worse than no proof.
7. Return AT MOST ${MAX_ANGLES} angles, and FEWER when the material only supports fewer. Two strong angles is a better answer than four where two are padded. Returning one, or none, is a valid and sometimes correct answer. Do not pad to reach a count.
8. Use only the ids given to you. Never invent an id.`;

/** Compact, id-labelled insight list for the prompt. */
function formatInsights(insights) {
  return insights
    .map(i => `[id ${i.id}] (${i.category}${i.source_ref ? `, ${i.source_ref}` : ''}) ${i.content}`)
    .join('\n');
}

/**
 * Validate one model-proposed angle against the real insight set.
 * Returns a clean angle row payload, or null if it must be dropped.
 */
function validateAngle(raw, validIds, usedSpines) {
  const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
  if (!title) return null;

  const spine = Number(raw.spine);
  // Models invent ids. A hallucinated spine has to drop the angle rather than
  // produce a brief with an empty claim block.
  if (!validIds.has(spine)) return null;
  // Rule 2 enforced in code, not on trust: a duplicate spine is a duplicate post.
  if (usedSpines.has(spine)) return null;

  const roles = { spine };
  for (const role of SUPPORT_ROLES) {
    const v = raw[role];
    if (v === null || v === undefined) continue;
    const id = Number(v);
    // Drop the individual role on a bad id, keep the angle — losing a mechanism
    // is survivable where losing the spine is not.
    if (!validIds.has(id)) continue;
    // A support that IS the spine adds nothing and would print the same insight twice.
    if (id === spine) continue;
    roles[role] = id;
  }

  // Rule 1: spine-only is just the existing single-insight path wearing a card.
  if (Object.keys(roles).length < 2) return null;

  return {
    title: title.slice(0, 300),
    roles,
    insightIds: [...new Set(Object.values(roles))],
  };
}

/**
 * Build and persist angles for one document. Idempotent: replaces whatever
 * angles the document already had, so a re-mine rebuilds rather than duplicating.
 *
 * Never throws — a failure here must not affect the document's 'ready' state or
 * the insights the user can already see. Returns the number of angles stored.
 */
async function buildAnglesForDocument(docId, userId, tenantId) {
  try {
    const { db, getSetting } = require('../db');

    const insights = await db.prepare(`
      SELECT id, category, content, source_ref
      FROM   vault_insights
      WHERE  document_id = ? AND tenant_id = ?
      ORDER  BY id ASC
    `).all(docId, tenantId);

    if (insights.length < MIN_INSIGHTS) {
      console.log(`[vaultAngles] doc=${docId} only ${insights.length} insights — nothing to bundle`);
      return 0;
    }

    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || (await getSetting('anthropic_api_key'));
    if (!apiKey) throw new Error('anthropic_api_key not configured');

    const client  = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model:         SONNET_MODEL,
      max_tokens:    2000,
      system:        SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: ANGLE_SCHEMA } },
      messages: [{
        role: 'user',
        content: `Insights mined from this document:\n\n${formatInsights(insights)}\n\nFind the arguments. Return at most ${MAX_ANGLES}, fewer if that is what the material honestly supports.`,
      }],
    });

    const text   = message.content.find(b => b.type === 'text')?.text || '{}';
    let proposed = [];
    try { proposed = JSON.parse(text).angles || []; } catch { proposed = []; }

    const validIds   = new Set(insights.map(i => Number(i.id)));
    const usedSpines = new Set();
    const accepted   = [];
    for (const raw of proposed) {
      if (accepted.length >= MAX_ANGLES) break;
      const angle = validateAngle(raw, validIds, usedSpines);
      if (!angle) continue;
      usedSpines.add(angle.roles.spine);
      accepted.push(angle);
    }

    // Proposed-vs-accepted is the padding signal. A widening gap means the model
    // is inventing ids or manufacturing spine-only angles to hit a count, which
    // is a prompt problem — and invisible if we only ever log the final number.
    console.log(`[vaultAngles] doc=${docId} insights=${insights.length} proposed=${proposed.length} accepted=${accepted.length}`);

    await db.transaction(async (tx) => {
      await tx.prepare('DELETE FROM vault_angles WHERE document_id = ? AND tenant_id = ?').run(docId, tenantId);
      const insert = tx.prepare(`
        INSERT INTO vault_angles (user_id, tenant_id, document_id, title, roles, insight_ids)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const a of accepted) {
        await insert.run(userId, tenantId, docId, a.title, JSON.stringify(a.roles), a.insightIds);
      }
    });

    return accepted.length;
  } catch (err) {
    console.error(`[vaultAngles] doc=${docId} failed (non-fatal):`, err.message);
    return 0;
  }
}

module.exports = {
  buildAnglesForDocument,
  validateAngle,
  formatInsights,
  // Exported for offline evaluation of the clustering prompt without a document
  // in the database — same reason organizePost exports EDITOR_SYSTEM.
  SYSTEM_PROMPT,
  ANGLE_SCHEMA,
  MIN_INSIGHTS,
  MAX_ANGLES,
  SUPPORT_ROLES,
};

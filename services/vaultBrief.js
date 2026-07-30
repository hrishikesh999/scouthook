'use strict';

/**
 * services/vaultBrief.js — assemble a role-labelled brief from vault insights.
 *
 * Phase 0 of sprint-vault-angles.md. Shared by the angle path and (eventually)
 * the single-insight path, so the brief format lives in exactly one place.
 *
 * Two things here are load-bearing and easy to undo by accident:
 *
 * 1. THE ROLE LABELS. An angle is not a set of insights, it is a claim plus
 *    material serving that claim. Hand a model four insights in a row and it
 *    writes "4 lessons from my case study" — a list, which is the forgettable
 *    format this whole design exists to avoid. Label which block is the claim
 *    and which are in service of it and it writes an argument instead.
 *
 * 2. THE HEADER DOES NOT CLAIM AUTHORSHIP. organizePost's own prompt asserts
 *    "the author told me this, in their own words" and instructs the model to
 *    preserve phrasing verbatim. That is right for a coach brief — the author
 *    literally just spoke it — and wrong for a document. Case studies, decks and
 *    one-pagers are frequently written formally or by marketing, so preserving
 *    their phrasing preserves agency prose while the retention score cheerfully
 *    reports "94% your words". The same distinction the Voice DNA rules already
 *    make (website copy deprioritised because "often written by a copywriter",
 *    LinkedIn headline trusted because "written by the user themselves").
 *
 *    So this header splits binding from non-binding: facts, numbers, names and
 *    outcomes must survive exactly; phrasing must not be preserved just because
 *    it appears in the document.
 *
 * NEVER give a document brief the coach header, or vice versa.
 */

// Canonical order. The model reads top-down, so the claim must come first and
// the "what to do" last regardless of what order the caller happens to pass.
const ROLE_ORDER = ['spine', 'tension', 'proof', 'mechanism', 'consequence'];

const ROLE_LABELS = {
  spine:       'SPINE — the claim this post makes',
  tension:     'TENSION — what this claim contradicts',
  proof:       'PROOF — the specific that backs it',
  mechanism:   'MECHANISM — why it works',
  consequence: 'CONSEQUENCE — what it means to do differently',
};

// A chunk is ~500 words. Four ungoverned passages plus neighbours would put
// ~3000 words in front of the model, where the thread gets lost and cost climbs
// for material that is mostly redundant. 1500 chars keeps a passage whole in
// almost every real case while bounding the pathological one.
const MAX_PASSAGE_CHARS = 1500;

const HEADER = (label) => `SOURCE MATERIAL from the author's own document${label ? ` "${label}"` : ''}.

This is the author's work, but it is not necessarily the author's writing. Case studies, decks and reports are usually written formally, and often by someone else on their behalf. Their LinkedIn register is in the AUTHOR VOICE section, and the finished post must land in THAT register, not in the document's.

WHAT IS BINDING: every fact, number, name, date, outcome and named method below. Carry them across exactly. Invent nothing that is not here.
WHAT IS NOT BINDING: the phrasing. Do not preserve corporate, formal or marketing wording just because it appears below. Say the same thing the way this author talks.

The labels below are scaffolding for you, not part of the post. Never echo a label.`;

/** Trim a passage to a sane length at a sentence boundary where possible. */
function clampPassage(text) {
  const s = String(text || '').trim();
  if (s.length <= MAX_PASSAGE_CHARS) return s;
  const cut = s.slice(0, MAX_PASSAGE_CHARS);
  // Prefer ending on a sentence so the model is not handed a severed clause.
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return (lastStop > MAX_PASSAGE_CHARS * 0.6 ? cut.slice(0, lastStop + 1) : cut).trim() + ' […]';
}

/**
 * Build a role-labelled brief.
 *
 * @param {object}   args
 * @param {string}  [args.filename]    document label, e.g. "london-gateway.pdf"
 * @param {Array}    args.blocks       [{ role, content, passage?, chunkId?, sourceRef? }]
 *                                     `content` is the mined insight line — a POINTER to the
 *                                     point. `passage` is the source prose — the actual
 *                                     material. Both are used; they are not interchangeable.
 * @param {string}  [args.neighbours]  adjacent-chunk context for the spine only
 * @returns {string}
 * @throws  {Error}  if no spine block is present — a brief without a claim has
 *                   nothing to organise material around, and silently emitting
 *                   one would produce exactly the listicle we are avoiding.
 */
function buildRoleBrief({ filename = '', blocks = [], neighbours = '' } = {}) {
  const usable = (Array.isArray(blocks) ? blocks : [])
    .filter(b => b && ROLE_LABELS[b.role] && String(b.content || '').trim());

  if (!usable.some(b => b.role === 'spine')) {
    throw new Error('buildRoleBrief: no spine block — an angle needs a claim');
  }

  const ordered = [...usable].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)
  );

  // Two roles often resolve to the same chunk. Printing it twice wastes context
  // and reads to the model as two independent sources agreeing, which is exactly
  // the false corroboration that invites it to overstate.
  const seenPassages = new Map(); // key -> role that printed it first
  const parts = [HEADER(filename)];

  for (const b of ordered) {
    const lines = [`${ROLE_LABELS[b.role]}:`, String(b.content).trim()];
    const passage = String(b.passage || '').trim();

    if (passage) {
      const key = b.chunkId != null ? `id:${b.chunkId}` : `tx:${passage.slice(0, 120)}`;
      const firstRole = seenPassages.get(key);
      if (firstRole) {
        lines.push(`(from the same passage as ${ROLE_LABELS[firstRole].split(' —')[0]}, above)`);
      } else {
        seenPassages.set(key, b.role);
        lines.push('', 'From the document:', clampPassage(passage));
      }
    } else {
      // No source passage resolved. The insight line is a CONDENSED restatement
      // written by the classifier, not the document's prose — so say so rather
      // than letting paraphrase pass as source material. Retention would score
      // this as faithful either way, which is why the honesty has to be here.
      lines.push('(condensed from the document — no source passage resolved; treat the point as accurate but the wording as ours, not the document\'s)');
    }

    parts.push(lines.join('\n'));
  }

  if (String(neighbours || '').trim()) {
    parts.push(`SURROUNDING CONTEXT (same document, around the spine — background only, not the subject of the post):\n${clampPassage(neighbours)}`);
  }

  return parts.join('\n\n---\n\n');
}

module.exports = {
  buildRoleBrief,
  ROLE_ORDER,
  ROLE_LABELS,
  MAX_PASSAGE_CHARS,
};

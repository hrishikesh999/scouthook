'use strict';

const { pool } = require('../db');

// Minimum approved posts before injection activates.
// Prevents underpopulated libraries from producing biased or repetitive examples.
const MIN_LIBRARY_SIZE = 40;

/**
 * Select up to 2 approved example posts for injection into the Stage 2 generation prompt.
 *
 * Waterfall matching (best match first, random within each tier):
 *   1. Exact match: post_type + hook_archetype
 *   2. Partial match: post_type only (any archetype)
 *   3. Any approved post (no match required)
 *
 * Returns [] if the total approved library is below MIN_LIBRARY_SIZE —
 * injection does not activate until the library is meaningfully seeded.
 *
 * @param {string|null} postType      — 'reach' | 'trust' | 'convert' | 'lead_magnet' | null
 * @param {string|null} hookArchetype — e.g. 'CONFESSION', 'MYTH_BUST', null
 * @returns {Promise<Array<{id: number, post_text: string}>>}
 */
async function selectExamples(postType, hookArchetype) {
  try {
    // Guard: check total library size before any matching
    const countResult = await pool.query(
      `SELECT COUNT(*) AS n FROM example_library WHERE approved = true AND retired = false`
    );
    const totalApproved = parseInt(countResult.rows[0]?.n ?? '0', 10);
    if (totalApproved < MIN_LIBRARY_SIZE) return [];

    const selected = [];
    const usedIds  = new Set();

    // ── Tier 1: exact match on post_type + hook_archetype ──────────────────
    if (postType && hookArchetype) {
      const rows = await pool.query(
        `SELECT id, post_text
           FROM example_library
          WHERE approved = true
            AND retired  = false
            AND post_type      = $1
            AND hook_archetype = $2
          ORDER BY RANDOM()
          LIMIT 2`,
        [postType, hookArchetype]
      );
      for (const row of rows.rows) {
        if (selected.length >= 2) break;
        selected.push(row);
        usedIds.add(row.id);
      }
    }

    // ── Tier 2: partial match on post_type only ─────────────────────────────
    if (selected.length < 2 && postType) {
      const needed = 2 - selected.length;
      const rows = await pool.query(
        `SELECT id, post_text
           FROM example_library
          WHERE approved = true
            AND retired  = false
            AND post_type = $1
            AND id != ALL($2::int[])
          ORDER BY RANDOM()
          LIMIT $3`,
        [postType, selected.length ? selected.map(r => r.id) : [0], needed]
      );
      for (const row of rows.rows) {
        selected.push(row);
        usedIds.add(row.id);
      }
    }

    // ── Tier 3: any approved post ───────────────────────────────────────────
    if (selected.length < 2) {
      const needed = 2 - selected.length;
      const rows = await pool.query(
        `SELECT id, post_text
           FROM example_library
          WHERE approved = true
            AND retired  = false
            AND id != ALL($1::int[])
          ORDER BY RANDOM()
          LIMIT $2`,
        [selected.length ? selected.map(r => r.id) : [0], needed]
      );
      for (const row of rows.rows) {
        selected.push(row);
      }
    }

    if (selected.length === 0) return [];

    // Increment times_used — fire-and-forget, never blocks generation
    const ids = selected.map(r => r.id);
    pool.query(
      `UPDATE example_library SET times_used = times_used + 1 WHERE id = ANY($1::int[])`,
      [ids]
    ).catch(() => {}); // intentionally swallowed

    return selected;
  } catch {
    return []; // library errors must never break generation
  }
}

/**
 * Format selected examples into a prompt block.
 * Returns empty string if no examples are provided.
 *
 * @param {Array<{post_text: string}>} examples
 * @returns {string}
 */
function buildExamplesBlock(examples) {
  if (!examples || examples.length === 0) return '';

  const exampleTexts = examples
    .map((e, i) => `--- EXAMPLE ${i + 1} ---\n${e.post_text.trim()}`)
    .join('\n\n');

  return `
QUALITY CALIBRATION:
The following posts represent the quality standard for this post type and hook.
Study the opening line, the structural moves between hook and close, and how the close lands.
Do not reproduce their content, phrasing, or specific ideas.
Write the new post at this quality level in the author's own voice, using only the author's material.

${exampleTexts}
`;
}

module.exports = { selectExamples, buildExamplesBlock };

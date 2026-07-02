'use strict';

/**
 * Shared utility for RAG-based vault context injection.
 * Called by routes/generate.js before dispatching to any post-type generator.
 */

/**
 * Build a structured context block from retrieved vault chunks/ideas.
 * Returns empty string when ragContext is empty so callers can use a simple
 * truthiness check before appending to raw_idea.
 *
 * @param {Array<{content: string, source_ref: string|null, filename: string}>} ragContext
 * @returns {string}
 */
function buildVaultContextBlock(ragContext) {
  if (!ragContext || ragContext.length === 0) return '';

  const passages = ragContext.map(c => {
    const label = c.source_ref
      ? `${c.filename} · ${c.source_ref}`
      : c.filename;
    return `[${label}]\n${String(c.content).slice(0, 400).trim()}`;
  }).join('\n\n');

  return `CONTEXT FROM THE AUTHOR'S OWN DOCUMENTS:\nVERBATIM EXTRACTION: If a passage below contains the author's exact phrasing, a specific outcome, a named framework, or a precise statistic — quote it verbatim in the post. Do not paraphrase. Do not summarise. Use the author's exact wording where directly relevant. Only include a passage if it genuinely fits the angle; if uncertain, omit it entirely — a forced quote is worse than no quote.\n\n${passages}`;
}

module.exports = { buildVaultContextBlock };

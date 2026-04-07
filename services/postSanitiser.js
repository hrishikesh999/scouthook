'use strict';

/**
 * Shared prohibition block injected into every generation system prompt.
 * Tells Claude explicitly what never to produce.
 */
const AI_TELLS_PROHIBITION = `
WRITING PROHIBITIONS — the following patterns expose AI authorship and must never appear:

Punctuation:
- Never use em dashes (—) for any purpose. Use a comma, a period, or restructure the sentence.

Banned vocabulary — replace with plain, specific language:
- delve / delves / delving → say "look at", "explore", "examine"
- tapestry, nuanced, multifaceted, pivotal, robust, seamless, seamlessly, comprehensive → be concrete instead
- foster, empower, elevate, leverage, showcase, unlock, streamline, transform → use specific verbs
- actionable, transformative, game-changing, cutting-edge, undeniable, groundbreaking → say the actual thing

Banned filler transitions — cut entirely:
- "That said," / "Having said that," / "It's worth noting"
- "Ultimately," / "In essence," / "At its core," / "At the end of the day"
- "It goes without saying" / "Needless to say"
`;

/**
 * Post-process generated text to strip the most mechanical AI tells.
 * Called immediately after JSON parsing, before quality gate.
 *
 * @param {string} text
 * @returns {string}
 */
function sanitiseAiTells(text) {
  return text
    // Em dash surrounded by spaces (parenthetical) → comma
    .replace(/ — /g, ', ')
    // Em dash with optional surrounding whitespace (any remaining case) → comma
    .replace(/\s*—\s*/g, ', ')
    // Clean up any double commas produced by replacements
    .replace(/,\s*,/g, ',')
    // Clean up comma immediately before terminal punctuation
    .replace(/,\s*\./g, '.')
    .replace(/,\s*!/g, '!')
    .replace(/,\s*\?/g, '?')
    // Clean up a leading comma at the start of a line (from em-dash list markers)
    .replace(/^,\s*/gm, '')
    .trim();
}

module.exports = { AI_TELLS_PROHIBITION, sanitiseAiTells };

'use strict';

/**
 * services/inputMaturity.js — decide whether the user handed us a SEED or a DRAFT.
 *
 * The bug this fixes: routes/generate.js used to send every typed input to
 * postEngine.generate(), whose base role grants the model "full authority over
 * the hook, structure, and phrasing" at temperature 0.8. That is correct for a
 * ten-word seed and destructive for someone who just wrote 300 words of their
 * own prose — their post came back as a competent, generic ghostwritten one.
 *
 * So: classify the input first, and route anything with real authored substance
 * to services/organizePost.js (editor, not writer) instead.
 *
 * Deliberately pure heuristic — no model call. Routing has to be deterministic:
 * the same paste must always take the same path, or the product feels arbitrary
 * and users can't learn what it does. It is also on the hot path before every
 * generation, so it must be free.
 *
 * Tiers:
 *   seed     — a fragment or one-liner. The author has nothing yet → interview
 *              / guided generation is the right help. Blank-page problem.
 *   raw      — real material, but spoken/bulleted/rambling → organise it.
 *   authored — substantially a written post already → organise, never rewrite.
 */

// Word counts, not characters: pasted posts carry lots of blank lines.
const RAW_MIN_WORDS      = 40;
const AUTHORED_MIN_WORDS = 120;
const AUTHORED_MIN_SENTS = 4;

/** Content words, ignoring markdown bullets and stray punctuation. */
function countWords(text) {
  const m = String(text || '').match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g);
  return m ? m.length : 0;
}

/**
 * Sentence count. Terminal punctuation OR a hard line break both end a sentence —
 * LinkedIn drafts are written one sentence per line and frequently omit periods,
 * so counting only ./!/? would score a finished post as a fragment.
 *
 * Two words is the floor: "Nobody noticed." is a real sentence in this format
 * and a very common beat, while one-word lines ("yes", "ok") are not.
 */
function countSentences(text) {
  const src = String(text || '').trim();
  if (!src) return 0;
  return src
    .split(/[.!?]+[\s)"'’”]*|\n+/)
    .map(s => s.trim())
    .filter(s => countWords(s) >= 2)
    .length;
}

/**
 * Classify how finished the author's input is.
 * @param {string} text  the user's OWN typed/spoken input — never a composed
 *                       brief, vault chunk, or AI-drafted idea card.
 * @returns {{ tier: 'seed'|'raw'|'authored', words: number, sentences: number, reason: string }}
 */
function classifyInputMaturity(text) {
  const src      = String(text || '').trim();
  const words     = countWords(src);
  const sentences = countSentences(src);

  if (words >= AUTHORED_MIN_WORDS && sentences >= AUTHORED_MIN_SENTS) {
    return { tier: 'authored', words, sentences, reason: 'long_multi_sentence' };
  }
  if (words >= RAW_MIN_WORDS) {
    return { tier: 'raw', words, sentences, reason: 'has_substance' };
  }
  return { tier: 'seed', words, sentences, reason: 'fragment' };
}

/**
 * Should this input be ORGANISED (author's words preserved) rather than written?
 * True for both 'raw' and 'authored' — once there is real material on the page,
 * the author's words beat the model's.
 */
function shouldOrganize(text) {
  return classifyInputMaturity(text).tier !== 'seed';
}

module.exports = {
  classifyInputMaturity,
  shouldOrganize,
  countWords,
  countSentences,
  RAW_MIN_WORDS,
  AUTHORED_MIN_WORDS,
  AUTHORED_MIN_SENTS,
};

/**
 * public/js/input-maturity.js — decide whether the user handed us a SEED or a DRAFT.
 *
 * ISOMORPHIC ON PURPOSE. This is the single source of truth for the input router,
 * loaded as a browser global (window.InputMaturity) and re-exported by
 * services/inputMaturity.js for the server.
 *
 * It has to be shared, because the routing decision is made twice: the browser
 * uses it to decide whether to run the content coach, and the server uses it to
 * decide between organizePost and postEngine. Two copies would drift, and when
 * they disagree the user gets coached on a post they already finished, then has
 * it ghostwritten anyway — which is the exact bug this file exists to prevent.
 *
 * Deliberately pure heuristic — no model call. Routing has to be deterministic:
 * the same paste must always take the same path, or the product feels arbitrary
 * and users can't learn what it does. It also runs on every keystroke-adjacent
 * check, so it must be free.
 *
 * Tiers:
 *   seed     — a fragment or one-liner. The author has nothing yet → coach and
 *              guided generation are the right help. Blank-page problem.
 *   raw      — real material, but spoken/bulleted/rambling → organise it.
 *   authored — substantially a written post already → organise, never rewrite,
 *              and never interrogate the author about it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InputMaturity = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

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
    const src       = String(text || '').trim();
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

  /**
   * Is this already a finished piece of writing? Stricter than shouldOrganize:
   * used to suppress the content coach, because interrogating someone about a
   * post they have already written is the most annoying thing the product can do.
   * Rough notes ('raw') still benefit from a question or two; a draft does not.
   */
  function isAuthoredDraft(text) {
    return classifyInputMaturity(text).tier === 'authored';
  }

  return {
    classifyInputMaturity,
    shouldOrganize,
    isAuthoredDraft,
    countWords,
    countSentences,
    RAW_MIN_WORDS,
    AUTHORED_MIN_WORDS,
    AUTHORED_MIN_SENTS,
  };
}));

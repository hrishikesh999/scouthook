'use strict';

/**
 * Shared synthesis dispatcher — all content paths go through here.
 * Designed in Phase 1, extended in Phase 2 — not rewritten.
 *
 * @param {object} userProfile — full user profile row from DB
 * @param {object} options
 * @param {string} [options.rawIdea]       — idea path: raw idea text from user
 * @param {object} [options.recipeAnswers] — recipe path: { slug, answers }
 * @param {Array}  [options.apifyPosts]    — Phase 2: filtered Apify posts
 * @param {object} [options.exaSignals]    — Phase 2: Exa research signals
 * @returns {Promise<
 *   | { synthesis: object, post: string, archetypeUsed: string, hookConfidence: number }
 *   | { synthesis: object, posts: Array<{ format_slug: string, content: string }> }
 * >}
 */
async function synthesise(userProfile, options = {}) {
  const { rawIdea = null, recipeAnswers = null, apifyPosts = null, exaSignals = null } = options;

  if (rawIdea) {
    const { ideaToPost } = require('./ideaPath');
    return ideaToPost(rawIdea, userProfile, options);
  }

  if (recipeAnswers) {
    const { recipesToPost } = require('./recipePath');
    return recipesToPost(recipeAnswers.slug, recipeAnswers.answers, userProfile, options);
  }

  if (apifyPosts && exaSignals) {
    // Phase 2 — full research synthesis
    // const { fullResearchSynthesis } = require('./researchSynthesis');
    // return fullResearchSynthesis(apifyPosts, exaSignals, userProfile);
    throw new Error('Research path not available in Phase 1');
  }

  throw new Error('synthesise() called with no valid path options');
}

module.exports = { synthesise };

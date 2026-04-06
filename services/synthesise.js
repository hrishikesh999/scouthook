'use strict';

async function synthesise(userProfile, options = {}) {
  const { rawIdea = null, recipeAnswers = null } = options;

  if (rawIdea) {
    const { ideaToPost } = require('./ideaPath');
    return ideaToPost(rawIdea, userProfile, options);
  }

  if (recipeAnswers) {
    const { recipesToPost } = require('./recipePath');
    return recipesToPost(recipeAnswers.slug, recipeAnswers.answers, userProfile, options);
  }

  throw new Error('synthesise() called with no valid path options');
}

module.exports = { synthesise };

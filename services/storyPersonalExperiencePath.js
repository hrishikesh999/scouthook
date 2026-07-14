'use strict';

// Story / Personal Experience post. Thin wrapper over the unified post engine —
// see services/postEngine.js and the 'story' entry in services/postRecipes.js.
// Consolidated in the authenticity-pipeline sprint (Phase 2).

const { generate } = require('./postEngine');

async function generateStoryPost(rawIdea, profile, { lengthPreference = 'Medium', ctaIntent = '' } = {}) {
  return generate('story', rawIdea, profile, { lengthPreference, ctaIntent });
}

module.exports = { generateStoryPost };

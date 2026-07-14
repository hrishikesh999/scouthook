'use strict';

// Behind-the-Scenes post. Thin wrapper over the unified post engine — see
// services/postEngine.js and the 'bts' entry in services/postRecipes.js.
// Consolidated in the authenticity-pipeline sprint (Phase 2).

const { generate } = require('./postEngine');

async function generateBtsPost(rawIdea, profile, { lengthPreference = 'Medium', ctaIntent = '' } = {}) {
  return generate('bts', rawIdea, profile, { lengthPreference, ctaIntent });
}

module.exports = { generateBtsPost };

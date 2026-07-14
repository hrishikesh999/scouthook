'use strict';

// Authority / Expertise post (the 'trust' post type). Thin wrapper over the
// unified post engine — see services/postEngine.js and the 'trust' entry in
// services/postRecipes.js. Consolidated in the authenticity-pipeline sprint (Phase 2).

const { generate } = require('./postEngine');

async function generateAuthorityPost(rawIdea, profile, { lengthPreference = 'Medium', ctaIntent = '' } = {}) {
  return generate('trust', rawIdea, profile, { lengthPreference, ctaIntent });
}

module.exports = { generateAuthorityPost };

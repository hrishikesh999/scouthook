'use strict';

// Contrarian / Hot Take post. Thin wrapper over the unified post engine — see
// services/postEngine.js and the 'contrarian' entry in services/postRecipes.js.
// Consolidated in the authenticity-pipeline sprint (Phase 2).

const { generate } = require('./postEngine');

async function generateContrarianPost(rawIdea, profile, { lengthPreference = 'Medium' } = {}) {
  return generate('contrarian', rawIdea, profile, { lengthPreference });
}

module.exports = { generateContrarianPost };

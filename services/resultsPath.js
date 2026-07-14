'use strict';

// Results / Case Study post. Thin wrapper over the unified post engine — see
// services/postEngine.js and the 'results' entry in services/postRecipes.js.
// The recipe carries the strongest provenance guard (never invent numbers).
// Consolidated in the authenticity-pipeline sprint (Phase 2).

const { generate } = require('./postEngine');

async function generateResultsPost(rawIdea, profile, { lengthPreference = 'Medium', ctaIntent = '' } = {}) {
  return generate('results', rawIdea, profile, { lengthPreference, ctaIntent });
}

module.exports = { generateResultsPost };

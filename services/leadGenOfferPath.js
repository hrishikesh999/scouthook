'use strict';

// Lead Gen Offer post (value-first soft invitation). Thin wrapper over the
// unified post engine — see services/postEngine.js and the 'lead_gen' entry in
// services/postRecipes.js. Consolidated in the authenticity-pipeline sprint (Phase 2).

const { generate } = require('./postEngine');

async function generateLeadGenPost(rawIdea, profile, { lengthPreference = 'Medium' } = {}) {
  return generate('lead_gen', rawIdea, profile, { lengthPreference });
}

module.exports = { generateLeadGenPost };

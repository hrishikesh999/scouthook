'use strict';

// Problem -> Insight -> Solution post (the 'pis' post type). Thin wrapper over the
// unified post engine — see services/postEngine.js and the 'pis' entry in
// services/postRecipes.js. Consolidated in the authenticity-pipeline sprint (Phase 2).
// The old prompt's "otherwise infer the hidden cause credibly" fabrication licence
// was dropped here — the recipe now says do NOT invent a cause when none is given.

const { generate } = require('./postEngine');

async function generatePisPost(rawIdea, profile, { lengthPreference = 'Medium' } = {}) {
  return generate('pis', rawIdea, profile, { lengthPreference });
}

module.exports = { generatePisPost };

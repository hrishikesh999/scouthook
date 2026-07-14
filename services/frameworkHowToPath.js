'use strict';

// Framework / How-To post. Thin wrapper over the unified post engine — see
// services/postEngine.js and the 'framework' entry in services/postRecipes.js.
// (The recipe sets allowEnumeration: true so numbered steps stay legal under the
// authenticity core's "no three parallel points" rule.) Phase 2 consolidation.

const { generate } = require('./postEngine');

async function generateFrameworkPost(rawIdea, profile, { lengthPreference = 'Medium' } = {}) {
  return generate('framework', rawIdea, profile, { lengthPreference });
}

module.exports = { generateFrameworkPost };

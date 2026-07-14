'use strict';

// Lessons Learned post. Thin wrapper over the unified post engine — see
// services/postEngine.js and the 'lessons_learned' entry in services/postRecipes.js.
// Consolidated in the authenticity-pipeline sprint (Phase 2).

const { generate } = require('./postEngine');

async function generateLessonsLearnedPost(rawIdea, profile, { lengthPreference = 'Medium', ctaIntent = '' } = {}) {
  return generate('lessons_learned', rawIdea, profile, { lengthPreference, ctaIntent });
}

module.exports = { generateLessonsLearnedPost };

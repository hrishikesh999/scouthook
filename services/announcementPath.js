'use strict';

// Announcement / goodwill (wishes, gratitude, greetings, appreciation).
// Thin wrapper over the unified post engine — see services/postEngine.js and the
// 'announcement' entry in services/postRecipes.js. Consolidated in the
// authenticity-pipeline sprint (Phase 2); the old per-type persona prompt,
// hashtag mandate, and copy-pasted author-context builder now live in one place.

const { generate } = require('./postEngine');

async function generateAnnouncementPost(rawIdea, profile, { lengthPreference = 'Medium' } = {}) {
  return generate('announcement', rawIdea, profile, { lengthPreference });
}

module.exports = { generateAnnouncementPost };

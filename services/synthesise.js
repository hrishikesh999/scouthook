'use strict';

async function synthesise(userProfile, options = {}) {
  const { rawIdea = null } = options;

  if (rawIdea) {
    const { ideaToPost } = require('./ideaPath');
    return ideaToPost(rawIdea, userProfile, options);
  }

  throw new Error('synthesise() called with no rawIdea');
}

module.exports = { synthesise };

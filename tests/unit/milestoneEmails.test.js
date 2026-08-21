'use strict';

/**
 * When the free-tier milestone emails fire.
 *
 * freeTierFlow.test.js tries to assert these by looking for an email_log row,
 * which can never appear: sendEmailToUser() returns at the top under
 * NODE_ENV=test, before any row is written. So the thresholds themselves are
 * tested here instead, on the pure function the sender now delegates to.
 *
 * What this is really guarding is that the timing stays relative to the
 * account's own cap. The free tier moved from 3 posts to 4 (migration 091) so
 * that the 4th post could generate and carry the upgrade ask in the editor
 * rather than being refused; the "one post left" and "cap reached" mails had to
 * move with it. They did so on their own because they read free_posts_limit —
 * anything keyed on "after the 3rd post" would have silently drifted a post
 * early, and admin grants would drift it further.
 */

const { milestoneTemplateFor } = require('../../services/postLifecycleEmails');

const freeUser = (used, limit = 4, extra = {}) => ({
  isPaid: false, optedOut: false, freePostsUsed: used, freePostsLimit: limit, ...extra,
});

describe('free-tier milestone emails', () => {
  test('silence until one post remains', () => {
    expect(milestoneTemplateFor(freeUser(0))).toBeNull();
    expect(milestoneTemplateFor(freeUser(1))).toBeNull();
    expect(milestoneTemplateFor(freeUser(2))).toBeNull();
  });

  test('"one left" lands after the 3rd of 4 posts, not the 2nd', () => {
    expect(milestoneTemplateFor(freeUser(3))).toBe('free-post-remaining');
  });

  test('"cap reached" lands after the 4th, alongside the in-editor ask', () => {
    // The same generation that returns free_tier_exhausted to the browser, so
    // the email and the editor panel say the same thing at the same time.
    expect(milestoneTemplateFor(freeUser(4))).toBe('free-cap-reached');
  });

  test('over the cap still reads as cap reached', () => {
    expect(milestoneTemplateFor(freeUser(7))).toBe('free-cap-reached');
  });

  test('an admin grant moves both milestones with it', () => {
    // limit 7: nothing at 4, "one left" at 6, "cap reached" at 7.
    expect(milestoneTemplateFor(freeUser(4, 7))).toBeNull();
    expect(milestoneTemplateFor(freeUser(6, 7))).toBe('free-post-remaining');
    expect(milestoneTemplateFor(freeUser(7, 7))).toBe('free-cap-reached');
  });

  test('paid and opted-out users get nothing', () => {
    expect(milestoneTemplateFor(freeUser(4, 4, { isPaid: true }))).toBeNull();
    expect(milestoneTemplateFor(freeUser(4, 4, { optedOut: true }))).toBeNull();
    expect(milestoneTemplateFor(null)).toBeNull();
  });
});

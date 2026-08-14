'use strict';

// Pure unit tests for the post-count-based lifecycle emails — no DB, no network.
const fs = require('fs');
const path = require('path');
const { getBehaviouralNudge, buildCtaBlock } = require('../../services/postLifecycleEmails');
const { sign, verify } = require('../../services/emailTokens');

const TEMPLATES_DIR = path.join(__dirname, '../../emails/templates');

/** A free-tier user who has done everything. Override per test. */
function state(overrides = {}) {
  return {
    isPaid: false,
    freeCapReached: false,
    freePostsUsed: 1,
    freePostsLimit: 3,
    optedOut: false,
    onboarded: true,
    linkedin: true,
    postsCount: 3,
    published: true,
    contentTheme: null,
    ...overrides,
  };
}

const none = new Set();

describe('behavioural nudge ladder', () => {
  test('un-onboarded users get the onboarding nudge', () => {
    const s = state({ onboarded: false });
    expect(getBehaviouralNudge(s, none)).toBe('trial-nudge-onboard-1');
  });

  test('onboarded users without LinkedIn get the LinkedIn nudge', () => {
    const s = state({ linkedin: false, postsCount: 0 });
    expect(getBehaviouralNudge(s, none)).toBe('trial-nudge-linkedin-1');
  });

  test('a nudge is never sent twice', () => {
    const s = state({ linkedin: false, postsCount: 0 });
    expect(getBehaviouralNudge(s, new Set(['trial-nudge-linkedin-1']))).toBeNull();
  });

  test('LinkedIn connected but no posts yet gets the generate nudge', () => {
    const s = state({ postsCount: 0 });
    expect(getBehaviouralNudge(s, none)).toBe('trial-nudge-generate-1');
  });

  test('a user blocked on LinkedIn with posts written gets the unblock email', () => {
    const s = state({ linkedin: false, postsCount: 2, published: false });
    expect(getBehaviouralNudge(s, none)).toBe('trial-need-linkedin-to-publish');
  });

  test('drafts sitting unpublished get the publish nudge', () => {
    const s = state({ postsCount: 2, published: false });
    expect(getBehaviouralNudge(s, none)).toBe('trial-nudge-publish-1');
  });

  test('a fully activated user with nothing scheduled gets nothing', () => {
    expect(getBehaviouralNudge(state(), none)).toBeNull();
  });
});

describe('state-aware CTA', () => {
  test('never asks a publisher to publish their first post', () => {
    expect(buildCtaBlock(state())).toContain('create your next post');
  });

  test('asks an un-onboarded user to finish setup instead', () => {
    expect(buildCtaBlock(state({ onboarded: false }))).toContain('voice profile');
  });

  test('asks for LinkedIn when it is the blocker', () => {
    const html = buildCtaBlock(state({ linkedin: false }));
    expect(html).toContain('Connect LinkedIn');
  });

  test('asks a user with drafts to publish, not to generate', () => {
    const html = buildCtaBlock(state({ published: false, postsCount: 2 }));
    expect(html).toContain('publish your first post');
  });

  test('a user who hit the free-post cap is pointed at billing', () => {
    const html = buildCtaBlock(state({ freeCapReached: true }));
    expect(html).toContain('/billing.html');
  });

  test('renders a plain text link, never a button', () => {
    const html = buildCtaBlock(state());
    expect(html).toContain('text-decoration:underline');
    expect(html).not.toMatch(/background:#[0-9a-f]{6}/i);
  });
});

describe('unsubscribe tokens', () => {
  const OLD = process.env.SESSION_SECRET;
  beforeAll(() => { process.env.SESSION_SECRET = 'test-secret-for-signing'; });
  afterAll(() => { process.env.SESSION_SECRET = OLD; });

  test('a token verifies for the user it was signed for', () => {
    expect(verify('user-a', sign('user-a'))).toBe(true);
  });

  test('a token does not verify for a different user', () => {
    expect(verify('user-b', sign('user-a'))).toBe(false);
  });

  test('garbage and empty tokens are rejected', () => {
    expect(verify('user-a', '')).toBe(false);
    expect(verify('user-a', 'x'.repeat(32))).toBe(false);
    expect(verify('user-a', null)).toBe(false);
  });

  test('a token for one purpose does not verify for another', () => {
    expect(verify('user-a', sign('user-a', 'unsub'), 'other')).toBe(false);
  });
});

describe('lifecycle templates', () => {
  const LIFECYCLE = [
    'welcome',
    'trial-nudge-onboard-1', 'trial-nudge-linkedin-1', 'trial-nudge-generate-1',
    'trial-need-linkedin-to-publish', 'trial-nudge-publish-1',
    'free-post-remaining', 'free-cap-reached', 'free-cap-followup',
  ];

  const read = name => fs.readFileSync(path.join(TEMPLATES_DIR, `${name}.html`), 'utf8');

  test.each(LIFECYCLE)('%s has a subject line', name => {
    expect(read(name)).toMatch(/<!--\s*subject:\s*.+?\s*-->/);
  });

  test.each(LIFECYCLE)('%s carries an unsubscribe link', name => {
    expect(read(name)).toContain('{{prefs_url}}');
  });

  test.each(LIFECYCLE)('%s uses the dark logo on a white background', name => {
    const html = read(name);
    expect(html).toContain('sh-logo-dark.png');
    expect(html).toContain('background:#ffffff');
  });

  test.each(LIFECYCLE)('%s has no buttons or coloured panels', name => {
    const html = read(name);
    // The only colours allowed are the link teal, body/muted greys, and the rule.
    const colours = [...html.matchAll(/background:(#[0-9a-fA-F]{3,6})/g)].map(m => m[1].toLowerCase());
    expect(colours.every(c => c === '#ffffff' || c === '#fff')).toBe(true);
    expect(html).not.toContain('border-radius');
  });

  test.each(LIFECYCLE)('%s is left-aligned', name => {
    expect(read(name)).toContain('text-align:left');
  });

  const DYNAMIC_CTA = ['free-post-remaining'];
  test.each(DYNAMIC_CTA)('%s defers its call to action to user state', name => {
    expect(read(name)).toContain('{{cta_block}}');
  });

  test.each(LIFECYCLE)('%s mentions no trial or day-count language', name => {
    const html = read(name).toLowerCase();
    expect(html).not.toContain('trial');
    expect(html).not.toContain('days_left');
  });

  test.each(LIFECYCLE)('%s leaves no unreplaced token beyond the known set', name => {
    const known = new Set([
      'name', 'display_name', 'app_url', 'upgrade_url', 'generate_url', 'settings_url',
      'linkedin_url', 'prefs_url', 'cta_block',
      'free_posts_used', 'free_posts_limit', 'free_posts_remaining',
      'posts_count', 'posts_count_label', 'industry', 'content_theme',
    ]);
    const tokens = [...read(name).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
    expect(tokens.filter(t => !known.has(t))).toEqual([]);
  });
});

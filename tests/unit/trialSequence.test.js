'use strict';

// Pure unit tests for the trial lifecycle sequence — no DB, no network.
const fs = require('fs');
const path = require('path');
const { getNextEmailTemplate, buildCtaBlock } = require('../../services/trialEmails');
const { sign, verify } = require('../../services/emailTokens');

const TEMPLATES_DIR = path.join(__dirname, '../../emails/templates');

/** A trialing user who has done everything. Override per test. */
function state(overrides = {}) {
  return {
    isPaid: false,
    isTrialActive: true,
    optedOut: false,
    daysLeft: 6,
    trialDay: 1,
    trialEndsAt: new Date('2026-08-10T00:00:00Z'),
    onboarded: true,
    linkedin: true,
    postsCount: 3,
    published: true,
    contentTheme: null,
    ...overrides,
  };
}

const none = new Set();

describe('trial sequence — day calendar', () => {
  test.each([
    [1, 6, 'nurture-1'],
    [2, 5, 'nurture-2'],
    [3, 4, 'nurture-3'],
    [5, 2, 'nurture-4'],
  ])('day %i sends %s', (trialDay, daysLeft, expected) => {
    expect(getNextEmailTemplate(state({ trialDay, daysLeft }), none)).toBe(expected);
  });

  test('day 4 sends the upgrade push to an activated user', () => {
    const s = state({ trialDay: 4, daysLeft: 3, published: true });
    expect(getNextEmailTemplate(s, none)).toBe('trial-convert-push');
  });

  test('day 4 sends the expiry warning to a user who never published', () => {
    const s = state({ trialDay: 4, daysLeft: 3, published: false, postsCount: 0 });
    expect(getNextEmailTemplate(s, none)).toBe('trial-expiry');
  });

  test('day 4 stays conversion-only — no nudge backfill once it has sent', () => {
    const s = state({ trialDay: 4, daysLeft: 3, published: false, postsCount: 0 });
    expect(getNextEmailTemplate(s, new Set(['trial-expiry']))).toBeNull();
  });

  test('last day beats everything, including an unsent sequence email', () => {
    const s = state({ trialDay: 6, daysLeft: 1, onboarded: false });
    expect(getNextEmailTemplate(s, none)).toBe('trial-last-day');
  });

  test('a sequence email is never sent twice', () => {
    const s = state({ trialDay: 2, daysLeft: 5 });
    expect(getNextEmailTemplate(s, new Set(['nurture-2']))).toBeNull();
  });
});

describe('trial sequence — behavioural fallback', () => {
  test('day 0 has no story email, so the stuck-user ladder runs', () => {
    const s = state({ trialDay: 0, daysLeft: 7, onboarded: false });
    expect(getNextEmailTemplate(s, none)).toBe('trial-nudge-onboard-1');
  });

  test('the ladder fills a day whose sequence email already went out', () => {
    const s = state({ trialDay: 1, daysLeft: 6, linkedin: false, postsCount: 0 });
    expect(getNextEmailTemplate(s, new Set(['nurture-1']))).toBe('trial-nudge-linkedin-1');
  });

  test('a user blocked on LinkedIn with posts written gets the unblock email', () => {
    const s = state({ trialDay: 0, daysLeft: 7, linkedin: false, postsCount: 2, published: false });
    expect(getNextEmailTemplate(s, none)).toBe('trial-need-linkedin-to-publish');
  });

  test('a fully activated user with nothing scheduled gets nothing', () => {
    const s = state({ trialDay: 0, daysLeft: 7 });
    expect(getNextEmailTemplate(s, none)).toBeNull();
  });
});

describe('trial sequence — suppression', () => {
  test('opted-out users get nothing, even on the last day', () => {
    expect(getNextEmailTemplate(state({ optedOut: true, daysLeft: 1, trialDay: 6 }), none)).toBeNull();
  });

  test('paying users get nothing', () => {
    expect(getNextEmailTemplate(state({ isPaid: true }), none)).toBeNull();
  });

  test('lapsed trials get nothing from the in-trial arc', () => {
    expect(getNextEmailTemplate(state({ isTrialActive: false, daysLeft: 0 }), none)).toBeNull();
  });

  test('an admin-extended trial past day 5 falls through without repeating', () => {
    const s = state({ trialDay: 9, daysLeft: 4 });
    expect(getNextEmailTemplate(s, new Set(['nurture-1', 'nurture-2']))).toBeNull();
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

  test('a lapsed non-buyer is pointed at billing', () => {
    const html = buildCtaBlock(state({ isTrialActive: false, isPaid: false }));
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
    'nurture-1', 'nurture-2', 'nurture-3', 'nurture-4', 'nurture-5',
    'trial-nudge-onboard-1', 'trial-nudge-linkedin-1', 'trial-nudge-generate-1',
    'trial-need-linkedin-to-publish', 'trial-nudge-publish-1',
    'trial-convert-push', 'trial-expiry', 'trial-last-day',
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

  const DYNAMIC_CTA = ['nurture-1', 'nurture-2', 'nurture-3', 'nurture-5'];
  test.each(DYNAMIC_CTA)('%s defers its call to action to user state', name => {
    expect(read(name)).toContain('{{cta_block}}');
  });

  test('nurture-4 sends the reader to their LinkedIn profile, not a dead link', () => {
    const html = read('nurture-4');
    expect(html).toContain('https://www.linkedin.com/in/me/');
    expect(html).not.toMatch(/href="\s*"/);
  });

  test.each(LIFECYCLE)('%s leaves no unreplaced token beyond the known set', name => {
    const known = new Set([
      'name', 'display_name', 'app_url', 'upgrade_url', 'generate_url', 'settings_url',
      'linkedin_url', 'prefs_url', 'cta_block', 'days_left', 'trial_end_date',
      'posts_count', 'posts_count_label', 'industry', 'content_theme',
    ]);
    const tokens = [...read(name).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
    expect(tokens.filter(t => !known.has(t))).toEqual([]);
  });
});

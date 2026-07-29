'use strict';

// Pure unit tests for the retention scorer — no DB, no network.
const {
  retentionScore, contentWords, normaliseWord,
  ORGANIZE_MIN_RETENTION, HOOK_LIFTED_MIN_RETENTION,
} = require('../../services/retention');

const SOURCE = `so we lost our biggest client in March, they went to a cheaper agency and I
assumed it was about price but when I called their CMO she said she never knew
if our work was actually doing anything, we were sending decks nobody opened so
we replaced the deck with a five minute Loom every Friday and churn dropped`;

// Reordered, trimmed, reformatted — but every word is the author's.
const ORGANISED = `We lost our biggest client in March.

They went to a cheaper agency, so I assumed it was about price.

It was not.

Their CMO said she never knew if our work was actually doing anything.
We were sending decks nobody opened.

We replaced the deck with a five minute Loom every Friday.

Churn dropped.`;

// Same topic, none of the author's words — the failure this metric exists to catch.
const GHOSTWRITTEN = `Here's an uncomfortable truth most agency owners refuse to confront.

Retention isn't a pricing conversation. It's a visibility conversation.

Three lessons that reshaped how I think about partnership:

1. Perceived value compounds faster than delivered value
2. Silence gets interpreted as absence
3. Transparency is the cheapest retention lever available

The best operators understand this instinctively.

Which lever are you pulling this quarter?`;

describe('retention — separating an edit from a rewrite', () => {
  test('an honest edit of the author\'s own words scores above the gate', () => {
    const r = retentionScore(SOURCE, ORGANISED);
    expect(r.score).toBeGreaterThanOrEqual(ORGANIZE_MIN_RETENTION);
    expect(r.total).toBeGreaterThan(0);
    expect(r.retained).toBeLessThanOrEqual(r.total);
  });

  test('a ghostwritten post on the same topic scores below the gate', () => {
    expect(retentionScore(SOURCE, GHOSTWRITTEN).score).toBeLessThan(ORGANIZE_MIN_RETENTION);
  });

  test('the two cases are separated by a wide margin, not a hair', () => {
    // If these ever converge the threshold is meaningless — that is the real
    // regression to catch, not either score in isolation.
    const good = retentionScore(SOURCE, ORGANISED).score;
    const bad  = retentionScore(SOURCE, GHOSTWRITTEN).score;
    expect(good - bad).toBeGreaterThan(0.5);
  });
});

describe('retention — detecting a written hook (organizePost rung 3)', () => {
  // organizePost may compose a first line when nothing in the draft is liftable.
  // Scoring that line alone is how we tell which rung it used, without asking the
  // model to self-report on the very behaviour we are auditing.
  const hookOf = post => post.split('\n').map(s => s.trim()).find(Boolean) || '';

  test('a lifted-and-tightened hook scores above the hook threshold', () => {
    const lifted = hookOf('We lost our biggest client in March.\n\nThey went to a cheaper agency.');
    expect(retentionScore(SOURCE, lifted).score).toBeGreaterThan(HOOK_LIFTED_MIN_RETENTION);
  });

  test('a composed hook scores at or below it', () => {
    const written = hookOf('Retention is a visibility problem, not a pricing problem.\n\nWe lost our biggest client in March.');
    expect(retentionScore(SOURCE, written).score).toBeLessThanOrEqual(HOOK_LIFTED_MIN_RETENTION);
  });

  test('the hook bar is more lenient than the whole-post one', () => {
    // A hook is ~10 words with no body text to absorb a single novel word, so a
    // strict bar would keep misreporting lifted hooks as composed. If this ever
    // inverts, the detector starts telling authors we wrote their own sentence.
    expect(HOOK_LIFTED_MIN_RETENTION).toBeLessThan(ORGANIZE_MIN_RETENTION);
  });
});

describe('retention — cutting is free', () => {
  test('a pure subset of the source scores 1', () => {
    // organizePost is allowed to cut freely, so unused source material must not
    // be penalised — only novel words the model introduced.
    const source  = 'I shipped the redesign on Tuesday and nobody noticed and that was exactly the point because good infrastructure is invisible to everyone';
    const trimmed = 'I shipped the redesign on Tuesday.\n\nNobody noticed.\n\nThat was the point.';
    expect(retentionScore(source, trimmed).score).toBe(1);
  });
});

describe('retention — normalisation', () => {
  test('plurals and -ies collapse to the base form', () => {
    expect(normaliseWord('clients')).toBe('client');
    expect(normaliseWord("client's")).toBe('client');
    expect(normaliseWord('agencies')).toBe('agency');
  });

  test('inflections converge on the base form despite consonant doubling', () => {
    expect(normaliseWord('shipping')).toBe(normaliseWord('ship'));
    expect(normaliseWord('shipped')).toBe(normaliseWord('ship'));
    expect(normaliseWord('running')).toBe(normaliseWord('run'));
  });

  test('l and s doubles are left alone so call/called and press/pressed still match', () => {
    expect(normaliseWord('called')).toBe(normaliseWord('call'));
    expect(normaliseWord('pressed')).toBe(normaliseWord('press'));
  });

  test('distinct words stay distinct — over-stemming would inflate the score', () => {
    expect(normaliseWord('price')).not.toBe(normaliseWord('pricing'));
  });

  test('stopwords are excluded so the score reflects authorship, not grammar', () => {
    const words = contentWords('The team and I have been working on it for a while');
    expect(words).not.toContain('the');
    expect(words).not.toContain('and');
    expect(words).toContain('team');
    expect(words).toContain('work');
  });
});

describe('retention — degenerate inputs', () => {
  test('an empty post invented nothing', () => {
    expect(retentionScore('anything', '').score).toBe(1);
    expect(retentionScore(null, null).score).toBe(1);
  });

  test('with no source, nothing in the post is the author\'s', () => {
    expect(retentionScore('', 'a wholly invented post about growth').score).toBe(0);
  });
});

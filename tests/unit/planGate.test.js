'use strict';

/**
 * The generate page's plan gate — who gets walled and who does not.
 *
 * This gate shipped reading `plan !== 'pro'`, which blocked a brand-new free
 * user with 0 of 3 posts used and every Solo subscriber besides. It stayed
 * invisible because /start.html was the first-run flow and never loaded this
 * file; the moment signup started landing on /generate.html, that read walled
 * every new account on the page it had just been sent to.
 *
 * public/js/generate.js is browser code with no harness — the same gap behind
 * three earlier production breakages (see startFlowContract.test.js). The
 * decision is therefore a pure function, lifted out of the source here and
 * exercised directly, so a regression fails a test rather than a signup.
 */

const fs   = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../../public/js/generate.js'), 'utf8');

/** Lift planGateDecision out of the browser bundle and make it callable. */
function loadDecision() {
  const start = SRC.indexOf('function planGateDecision(sub) {');
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  const source = SRC.slice(start, end + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`${source}; return planGateDecision;`)();
}

const planGateDecision = loadDecision();

const freeUser = (used, limit = 4, extra = {}) => ({
  ok: true, plan: 'expired', free_posts_used: used, free_posts_limit: limit, ...extra,
});

describe('plan gate — who reaches the generator', () => {
  test('a brand-new free user is never blocked', () => {
    // The signup flow lands here seconds after the PIN screen. If this ever
    // returns blocked again, every new account hits a wall on arrival.
    expect(planGateDecision(freeUser(0)).blocked).toBe(false);
  });

  test('a free user part-way through their posts is not blocked', () => {
    expect(planGateDecision(freeUser(1)).blocked).toBe(false);
    expect(planGateDecision(freeUser(3)).blocked).toBe(false);
  });

  test('a free user who has spent every post is blocked', () => {
    const decision = planGateDecision(freeUser(4));
    expect(decision.blocked).toBe(true);
    expect(decision.limit).toBe(4);
    expect(decision.lapsed).toBe(false);
  });

  test('over the cap still blocks — admin grants and gate-failing posts can skew the count', () => {
    expect(planGateDecision(freeUser(9)).blocked).toBe(true);
  });

  test('a granted higher cap reopens the page', () => {
    // Admin's "grant more free posts" raises free_posts_limit; the gate must
    // follow it rather than a hard-coded 3.
    expect(planGateDecision(freeUser(4, 6)).blocked).toBe(false);
  });

  test('paid plans are never gated client-side', () => {
    // Their monthly quota is enforced server-side at generation, where the
    // count is authoritative. Solo was collateral damage of the old check.
    expect(planGateDecision({ ok: true, plan: 'solo' }).blocked).toBe(false);
    expect(planGateDecision({ ok: true, plan: 'pro' }).blocked).toBe(false);
  });

  test('a lapsed subscriber is blocked, but not told they used free posts', () => {
    const decision = planGateDecision(freeUser(4, 4, { canceled_at: '2026-07-01T00:00:00Z' }));
    expect(decision.blocked).toBe(true);
    expect(decision.lapsed).toBe(true);
  });

  test('fails open on a missing or unreadable response', () => {
    // A display bug or a failed fetch must never wall the app.
    expect(planGateDecision(null).blocked).toBe(false);
    expect(planGateDecision({ ok: false }).blocked).toBe(false);
    expect(planGateDecision({ ok: true, plan: 'expired' }).blocked).toBe(false);
    expect(planGateDecision(freeUser(2, null)).blocked).toBe(false);
  });
});

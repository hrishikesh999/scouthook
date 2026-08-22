'use strict';

/**
 * The plan matrix: who pays, what they get, and how a Paddle price maps back.
 *
 * The failure this guards against is quiet rather than loud. Every paid-plan
 * check used to be spelled `['solo','pro'].includes(plan)`, in ten places across
 * four files. Adding Deluxe without catching all ten would not crash anything —
 * it would treat a paying customer as free tier: walled out of the generator by
 * the plan gate, counted against the four-post cap, and emailed about the free
 * posts they had supposedly used up.
 */

const {
  PLAN_FEATURES, PLAN_LIMITS,
  isPaidPlan, getWorkspaceLimit, getMonthlyPostLimit, planHasFeature, rankPlan,
} = require('../../lib/planFeatures');

describe('paid vs free', () => {
  test('every purchasable tier counts as paid', () => {
    expect(isPaidPlan('pro')).toBe(true);
    expect(isPaidPlan('deluxe')).toBe(true);
    expect(isPaidPlan('solo')).toBe(true); // legacy, not purchasable, still paid
  });

  test('free tier and nonsense do not', () => {
    expect(isPaidPlan('expired')).toBe(false);
    expect(isPaidPlan(null)).toBe(false);
    expect(isPaidPlan(undefined)).toBe(false);
    expect(isPaidPlan('pro ')).toBe(false);
    expect(isPaidPlan('PRO')).toBe(false);
  });

  test('every plan in the limits table has a paid/free answer that matches its limits', () => {
    // A plan with post or workspace allowance that reads as unpaid is the exact
    // shape of the bug this file exists for.
    for (const [plan, limits] of Object.entries(PLAN_LIMITS)) {
      const hasAllowance = limits.monthly_posts > 0 || limits.workspaces > 0;
      expect(isPaidPlan(plan)).toBe(hasAllowance);
    }
  });
});

describe('plan limits', () => {
  test('Pro is one workspace at the $19 price, not two', () => {
    expect(getWorkspaceLimit('pro')).toBe(1);
  });

  test('Deluxe is five', () => {
    expect(getWorkspaceLimit('deluxe')).toBe(5);
  });

  test('free tier owns none', () => {
    expect(getWorkspaceLimit('expired')).toBe(0);
  });

  test('add-on workspaces stack only where the plan sells them', () => {
    expect(getWorkspaceLimit('pro', 2)).toBe(3);
    expect(getWorkspaceLimit('deluxe', 2)).toBe(7);
    // expired has no extra_workspaces feature, so a stale add-on count on a
    // lapsed subscription must not hand back workspaces they no longer pay for.
    expect(getWorkspaceLimit('expired', 3)).toBe(0);
    expect(getWorkspaceLimit('solo', 3)).toBe(1);
  });

  test('both paid tiers generate without a monthly ceiling', () => {
    expect(getMonthlyPostLimit('pro')).toBe(Infinity);
    expect(getMonthlyPostLimit('deluxe')).toBe(Infinity);
    expect(getMonthlyPostLimit('expired')).toBe(0);
  });

  test('Deluxe carries every Pro capability', () => {
    // The spec is "everything in Pro, plus room". If a feature is ever added to
    // Pro alone, the more expensive plan would quietly have less.
    for (const feature of PLAN_FEATURES.pro) {
      expect(planHasFeature('deluxe', feature)).toBe(true);
    }
  });

  test('free tier has no features at all', () => {
    expect(PLAN_FEATURES.expired.size).toBe(0);
    expect(planHasFeature('expired', 'vault')).toBe(false);
    expect(planHasFeature('expired', 'scheduling')).toBe(false);
  });
});

describe('plan ranking', () => {
  test('orders the tiers so up and downgrades are distinguishable', () => {
    // billing.js uses this to decide whether to put excess workspaces into a
    // grace period. A Deluxe -> Pro move must read as a downgrade, or five
    // workspaces stay live on a one-workspace plan.
    expect(rankPlan('deluxe')).toBeGreaterThan(rankPlan('pro'));
    expect(rankPlan('pro')).toBeGreaterThan(rankPlan('solo'));
    expect(rankPlan('solo')).toBeGreaterThan(rankPlan('expired'));
  });

  test('an unknown plan ranks lowest rather than throwing', () => {
    expect(rankPlan('mystery')).toBe(0);
    expect(rankPlan(undefined)).toBe(0);
  });
});

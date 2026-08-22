'use strict';

// Paid tiers as of the 2026-08 pricing experiment: Pro at $19 for one person and
// one brand, Deluxe at $49 for several brands or a team. 'solo' predates both,
// is not purchasable, and is kept only so existing rows and rank comparisons
// keep working.
const PLAN_FEATURES = {
  expired: new Set([]),
  solo: new Set(['generate', 'publish_immediate', 'scheduling', 'vault']),
  pro:  new Set(['generate', 'publish_immediate', 'scheduling', 'vault',
                 'carousel', 'company_pages', 'team_members', 'extra_workspaces']),
  // Deluxe is Pro plus room: same capabilities, more workspaces.
  deluxe: new Set(['generate', 'publish_immediate', 'scheduling', 'vault',
                   'carousel', 'company_pages', 'team_members', 'extra_workspaces']),
};

const PLAN_LIMITS = {
  expired: { workspaces: 0, monthly_posts: 0,  linkedin_personal: 0 },
  solo: { workspaces: 1, monthly_posts: 20, linkedin_personal: 1 },
  // Pro dropped from 2 workspaces to 1 with the $19 price — a second brand is
  // the thing Deluxe is for.
  pro:  { workspaces: 1, monthly_posts: Infinity, linkedin_personal: 1 },
  deluxe: { workspaces: 5, monthly_posts: Infinity, linkedin_personal: 1 },
};

/**
 * Does this plan pay us?
 *
 * Exists because the answer used to be spelled `['solo','pro'].includes(plan)`
 * in ten separate files, and adding a tier meant finding all ten. Missing one
 * does not fail loudly: it silently treats a paying customer as free tier —
 * walled out of the generator, counted against the free post cap, and sent
 * "you've used your free posts" email. One place to be wrong is the point.
 */
function isPaidPlan(plan) {
  return plan === 'solo' || plan === 'pro' || plan === 'deluxe';
}

function getWorkspaceLimit(plan, extraWorkspaces = 0) {
  const base = PLAN_LIMITS[plan]?.workspaces ?? 1;
  // Add-on workspaces only apply where the plan sells them.
  const canBuyExtra = PLAN_FEATURES[plan]?.has('extra_workspaces');
  return base + (canBuyExtra ? (extraWorkspaces || 0) : 0);
}

function getMonthlyPostLimit(plan) {
  return PLAN_LIMITS[plan]?.monthly_posts ?? 0;
}

function planHasFeature(plan, feature) {
  return PLAN_FEATURES[plan ?? 'expired']?.has(feature) ?? false;
}

/** Returns a numeric rank so plan changes can be compared as up/downgrades. */
function rankPlan(plan) {
  return { expired: 0, solo: 1, pro: 2, deluxe: 3 }[plan] ?? 0;
}

module.exports = {
  PLAN_FEATURES, PLAN_LIMITS,
  isPaidPlan, getWorkspaceLimit, getMonthlyPostLimit, planHasFeature, rankPlan,
};

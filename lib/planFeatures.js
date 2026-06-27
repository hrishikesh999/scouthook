'use strict';

const PLAN_FEATURES = {
  expired: new Set([]),
  solo: new Set(['generate', 'publish_immediate', 'scheduling', 'vault']),
  pro:  new Set(['generate', 'publish_immediate', 'scheduling', 'vault',
                 'carousel', 'company_pages', 'team_members', 'extra_workspaces']),
};

const PLAN_LIMITS = {
  expired: { workspaces: 0, monthly_posts: 0,  linkedin_personal: 0 },
  solo: { workspaces: 1, monthly_posts: 20, linkedin_personal: 1 },
  pro:  { workspaces: 2, monthly_posts: Infinity, linkedin_personal: 1 },
};

function getWorkspaceLimit(plan, extraWorkspaces = 0) {
  const base = PLAN_LIMITS[plan]?.workspaces ?? 1;
  return base + (plan === 'pro' ? (extraWorkspaces || 0) : 0);
}

function getMonthlyPostLimit(plan) {
  return PLAN_LIMITS[plan]?.monthly_posts ?? 0;
}

function planHasFeature(plan, feature) {
  return PLAN_FEATURES[plan ?? 'expired']?.has(feature) ?? false;
}

/** Returns a numeric rank so plan changes can be compared as up/downgrades. */
function rankPlan(plan) {
  return { expired: 0, solo: 1, pro: 2 }[plan] ?? 0;
}

module.exports = { PLAN_FEATURES, PLAN_LIMITS, getWorkspaceLimit, getMonthlyPostLimit, planHasFeature, rankPlan };

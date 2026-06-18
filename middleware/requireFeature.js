'use strict';

const { getUserPlan } = require('../services/subscription');
const { planHasFeature } = require('../lib/planFeatures');

// Map each feature to the minimum plan that unlocks it — used in 403 responses.
const REQUIRED_PLAN = {
  scheduling:                  'solo',
  vault:                       'solo',
  carousel:                    'pro',
  company_pages:               'pro',
  team_members:                'pro',
  extra_workspaces:            'pro',
};

/**
 * requireFeature(feature) → Express middleware
 * Returns 403 { error: 'feature_not_available', feature, requiredPlan }
 * when the requesting user's plan does not include the named feature.
 */
function requireFeature(feature) {
  const requiredPlan = REQUIRED_PLAN[feature] || 'pro';
  return async (req, res, next) => {
    try {
      const plan = await getUserPlan(req.userId);
      if (!planHasFeature(plan, feature)) {
        return res.status(403).json({
          ok: false,
          error: 'feature_not_available',
          feature,
          requiredPlan,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireFeature };

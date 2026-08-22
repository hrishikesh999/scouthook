'use strict';

/**
 * The plan catalog: what is offered, at what price, and which Paddle price maps
 * back to which plan.
 *
 * Two failures matter here and neither is loud:
 *
 * 1. Offering a plan whose Paddle price is not configured. The card renders, the
 *    user clicks, and checkout 500s on price_not_configured. Deluxe is expected
 *    to ship before its price exists, so "unconfigured means unoffered" is the
 *    property that makes that safe.
 *
 * 2. Mapping an unrecognised price to 'expired'. The likeliest cause of an
 *    unknown price ID is an env var we have not set yet, not a lapsed
 *    subscription — and downgrading a paying customer over our own missing
 *    config is the worse of the two mistakes.
 */

const ENV_KEYS = ['PADDLE_PRICE_ID_PRO', 'PADDLE_PRICE_ID_DELUXE', 'PADDLE_PRICE_ID_YEARLY'];

const savedEnv = {};
beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/**
 * Apply price-id env vars and hand back the catalog.
 *
 * The env must stay applied while the assertions run: these functions read
 * process.env when they are CALLED, not when the module is required, which is
 * what lets an operator set a price id without a redeploy.
 */
function loadCatalog(env) {
  Object.assign(process.env, env);
  return require('../../services/subscription');
}

const BOTH = { PADDLE_PRICE_ID_PRO: 'pri_pro', PADDLE_PRICE_ID_DELUXE: 'pri_dlx' };

describe('what is purchasable', () => {
  test('both plans, priced as agreed, when both prices are configured', () => {
    const { purchasablePlans } = loadCatalog(BOTH);
    const plans = purchasablePlans();
    expect(plans.map(p => p.plan)).toEqual(['pro', 'deluxe']);
    expect(plans.find(p => p.plan === 'pro').price).toBe(19);
    expect(plans.find(p => p.plan === 'deluxe').price).toBe(49);
  });

  test('Deluxe is not offered until its Paddle price exists', () => {
    // The state this ships in. The overlay renders Pro alone rather than a card
    // whose button cannot open a checkout.
    const { purchasablePlans } = loadCatalog({ PADDLE_PRICE_ID_PRO: 'pri_pro' });
    expect(purchasablePlans().map(p => p.plan)).toEqual(['pro']);
  });

  test('nothing is offered when nothing is configured', () => {
    const { purchasablePlans } = loadCatalog({});
    expect(purchasablePlans()).toEqual([]);
  });

  test('a blank env var counts as unconfigured, not as a price id', () => {
    const { purchasablePlans } = loadCatalog({ PADDLE_PRICE_ID_PRO: 'pri_pro', PADDLE_PRICE_ID_DELUXE: '   ' });
    expect(purchasablePlans().map(p => p.plan)).toEqual(['pro']);
  });

  test('solo is not in the catalog and so cannot be bought', () => {
    const { planCatalogEntry } = loadCatalog(BOTH);
    expect(planCatalogEntry('solo')).toBeNull();
    expect(planCatalogEntry('expired')).toBeNull();
    expect(planCatalogEntry(undefined)).toBeNull();
  });
});

describe('price id to plan', () => {
  test('each configured price maps back to its own plan', () => {
    const { planForPriceId } = loadCatalog(BOTH);
    expect(planForPriceId('pri_pro')).toBe('pro');
    expect(planForPriceId('pri_dlx')).toBe('deluxe');
  });

  test('the yearly price is still Pro', () => {
    const { planForPriceId } = loadCatalog({ ...BOTH, PADDLE_PRICE_ID_YEARLY: 'pri_year' });
    expect(planForPriceId('pri_year')).toBe('pro');
  });

  test('an unknown price returns null so callers can decline to downgrade', () => {
    const { planForPriceId } = loadCatalog(BOTH);
    expect(planForPriceId('pri_something_else')).toBeNull();
    expect(planForPriceId(null)).toBeNull();
    expect(planForPriceId('')).toBeNull();
  });

  test('the Deluxe price does not read as Pro before its env var is set', () => {
    // Without this, a Deluxe subscriber whose price we cannot resolve lands on
    // Pro limits — one workspace instead of five, on a $49 subscription.
    const { planForPriceId } = loadCatalog({ PADDLE_PRICE_ID_PRO: 'pri_pro' });
    expect(planForPriceId('pri_dlx')).toBeNull();
  });
});

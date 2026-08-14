'use strict';

// Plan gate: publishing must be blocked once the user's plan has expired.
// publishNow is the single choke point for both the immediate /publish route
// and the scheduled-post worker, so the gate lives there — a post scheduled
// while Pro must NOT publish after the plan lapses.
// getUserPlan is mocked so no DB/Paddle access happens; the gate must throw
// before any rate-limit or LinkedIn API work.

jest.mock('../../services/subscription', () => ({
  getUserPlan: jest.fn(),
  // 'expired' covers two populations since the free tier landed: a free user who
  // never subscribed (no paddle_subscription_id — still allowed to publish) and a
  // lapsed Paddle subscriber (refused). The gate reads the subscription to tell
  // them apart, so this mock has to exist or it throws before reaching the check.
  getUserSubscription: jest.fn(),
}));

const { getUserPlan, getUserSubscription } = require('../../services/subscription');
const { publishNow } = require('../../services/linkedinPublisher');

describe('publishNow — plan gate', () => {
  beforeEach(() => jest.clearAllMocks());

  test('throws plan_expired for a lapsed Paddle subscriber before doing any work', async () => {
    getUserPlan.mockResolvedValue('expired');
    getUserSubscription.mockResolvedValue({ paddle_subscription_id: 'sub_123' });
    await expect(publishNow('user-1', 'tenant-1', 'hello world'))
      .rejects.toThrow('plan_expired');
    expect(getUserPlan).toHaveBeenCalledWith('user-1');
  });

  test('a free user who never subscribed is NOT refused as expired', async () => {
    getUserPlan.mockResolvedValue('expired');
    getUserSubscription.mockResolvedValue({ paddle_subscription_id: null });
    let err;
    try {
      await publishNow('user-1', 'tenant-1', 'hello world');
    } catch (e) {
      err = e;
    }
    // Fails later (no connection), but must not be stopped by the plan gate.
    expect(err).toBeDefined();
    expect(err.message).not.toBe('plan_expired');
  });

  test('active plan proceeds past the gate (fails later on rate-limit/connection, not plan_expired)', async () => {
    getUserPlan.mockResolvedValue('pro');
    let err;
    try {
      await publishNow('user-1', 'tenant-1', 'hello world');
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.message).not.toBe('plan_expired');
  });
});

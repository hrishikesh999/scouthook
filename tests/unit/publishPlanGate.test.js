'use strict';

// Plan gate: publishing must be blocked once the user's plan has expired.
// publishNow is the single choke point for both the immediate /publish route
// and the scheduled-post worker, so the gate lives there — a post scheduled
// while Pro must NOT publish after the plan lapses.
// getUserPlan is mocked so no DB/Paddle access happens; the gate must throw
// before any rate-limit or LinkedIn API work.

jest.mock('../../services/subscription', () => ({
  getUserPlan: jest.fn(),
}));

const { getUserPlan } = require('../../services/subscription');
const { publishNow } = require('../../services/linkedinPublisher');

describe('publishNow — plan gate', () => {
  beforeEach(() => jest.clearAllMocks());

  test('throws plan_expired for an expired plan before doing any work', async () => {
    getUserPlan.mockResolvedValue('expired');
    await expect(publishNow('user-1', 'tenant-1', 'hello world'))
      .rejects.toThrow('plan_expired');
    expect(getUserPlan).toHaveBeenCalledWith('user-1');
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

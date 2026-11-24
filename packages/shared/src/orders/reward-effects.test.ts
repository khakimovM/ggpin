import { describe, expect, it } from 'vitest';
import { notifyJobId, notifyJobSchema } from '../notify';
import { rewardEffectsOf, type DeliveryRewardFacts } from './order-effects-plan';

// Synthetic ids only.
const facts: DeliveryRewardFacts = {
  orderId: 'cmorder1abc',
  buyerId: 'cmbuyer1abc',
  referrerId: 'cminviter1abc',
  referralTiyin: 10_000n,
  cashbackCoins: 1n,
};

describe('rewardEffectsOf (phase 10, plan 3.1)', () => {
  it('a bonus and cashback: the inviter is told, both caches go', () => {
    const plan = rewardEffectsOf(facts);
    expect(plan.notifyJobs).toEqual([{ kind: 'REFERRAL_BONUS', refId: 'cmorder1abc' }]);
    expect(plan.notifyJobs.map((job) => notifyJobId(notifyJobSchema.parse(job)))).toEqual([
      'referral-cmorder1abc',
    ]);
    expect(plan.invalidateWalletOf).toBe('cminviter1abc');
    expect(plan.invalidateCoinsOf).toBe('cmbuyer1abc');
  });

  it('no inviter: no message and no wallet cache, cashback still clears the coin cache', () => {
    const plan = rewardEffectsOf({ ...facts, referrerId: null, referralTiyin: 0n });
    expect(plan).toEqual({
      notifyJobs: [],
      invalidateWalletOf: null,
      invalidateCoinsOf: 'cmbuyer1abc',
    });
  });

  it('a bonus of 0 (daily cap, rate 0) tells nobody; no cashback clears nothing', () => {
    const plan = rewardEffectsOf({ ...facts, referralTiyin: 0n, cashbackCoins: 0n });
    expect(plan).toEqual({ notifyJobs: [], invalidateWalletOf: null, invalidateCoinsOf: null });
  });

  it('the same facts plan the same ids (a replay after a crash queues nothing new)', () => {
    expect(rewardEffectsOf(facts)).toEqual(rewardEffectsOf({ ...facts }));
  });
});

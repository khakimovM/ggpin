import { describe, expect, it } from 'vitest';
import { NOTIFY_KINDS, PROMO_NOTIFY_KINDS, notifyJobId, notifyJobSchema } from './notify';

// Phase 10 (D-72): ids only, like every other customer notice; the API reads the rest.
describe('promo notify jobs', () => {
  it('both kinds are notify kinds and take one row id and nothing else', () => {
    expect([...PROMO_NOTIFY_KINDS]).toEqual(['REFERRAL_BONUS', 'BONUS_REDEEMED']);
    for (const kind of PROMO_NOTIFY_KINDS) {
      expect(NOTIFY_KINDS).toContain(kind);
      expect(notifyJobSchema.safeParse({ kind, refId: 'cm0row1' }).success).toBe(true);
      for (const extra of [{ userId: 'cm0user1' }, { amountTiyin: '100' }, { text: 'x' }]) {
        expect(notifyJobSchema.safeParse({ kind, refId: 'cm0row1', ...extra }).success).toBe(false);
      }
      expect(notifyJobSchema.safeParse({ kind }).success).toBe(false);
      expect(notifyJobSchema.safeParse({ kind, refId: 'a-b' }).success).toBe(false);
    }
  });

  it('one message per order bonus and per redemption', () => {
    expect(notifyJobId({ kind: 'REFERRAL_BONUS', refId: 'cm0order1' })).toBe('referral-cm0order1');
    expect(notifyJobId({ kind: 'BONUS_REDEEMED', refId: 'cm0red1' })).toBe('bonus-cm0red1');
  });

  it('a referral bonus never shares a job id with the same order’s own notices', () => {
    const id = 'cm0order1';
    const bonus = notifyJobId({ kind: 'REFERRAL_BONUS', refId: id });
    expect(bonus).not.toBe(notifyJobId({ kind: 'ORDER_DELIVERED', refId: id }));
    expect(bonus).not.toBe(notifyJobId({ kind: 'BONUS_REDEEMED', refId: id }));
  });
});

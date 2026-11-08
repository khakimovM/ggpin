import { describe, expect, it } from 'vitest';
import { alertRef, notifyJobId, notifyJobSchema, parseForeignChatAlertRef } from './notify';

describe('notifyJobSchema', () => {
  it('accepts the three shapes', () => {
    expect(notifyJobSchema.safeParse({ kind: 'TOPUP_CREDITED', refId: 'p1' }).success).toBe(true);
    expect(notifyJobSchema.safeParse({ kind: 'TOPUP_LATE_CREDITED', refId: 'p1' }).success).toBe(
      true,
    );
    expect(
      notifyJobSchema.safeParse({ kind: 'OWNER_ALERT', alert: 'chainBreak', refId: 'r1' }).success,
    ).toBe(true);
  });

  it('rejects an amount, a text or any unknown key: the payload is ids only', () => {
    const withAmount = {
      kind: 'TOPUP_CREDITED',

      refId: 'p1',
      amountTiyin: '1',
    };
    expect(notifyJobSchema.safeParse(withAmount).success).toBe(false);
    const withText = { kind: 'OWNER_ALERT', alert: 'noMatch', refId: 'r', text: 'x' };
    expect(notifyJobSchema.safeParse(withText).success).toBe(false);
  });

  it('rejects an unknown alert, an unknown kind and a top-up without a user', () => {
    const unknownAlert = { kind: 'OWNER_ALERT', alert: 'boom', refId: 'r' };
    expect(notifyJobSchema.safeParse(unknownAlert).success).toBe(false);
    expect(notifyJobSchema.safeParse({ kind: 'OTHER', refId: 'r' }).success).toBe(false);
    expect(notifyJobSchema.safeParse({ kind: 'TOPUP_CREDITED' }).success).toBe(false);
  });
});

describe('alertRef', () => {
  it('builds refIds that the schema and the job id builder accept', () => {
    const frozen = alertRef.walletFrozen('cm3user1', 'cm3ledger1');
    const silent = alertRef.cardSilent('cm3card1', new Date('2026-11-04T07:00:00.000Z'));
    expect(frozen).toBe('cm3user1_cm3ledger1');
    expect(silent).toBe('cm3card1_1793775600');
    for (const [alert, refId] of [
      ['walletFrozen', frozen],
      ['cardSilent', silent],
    ] as const) {
      const job = { kind: 'OWNER_ALERT', alert, refId } as const;
      expect(notifyJobSchema.safeParse(job).success).toBe(true);
      expect(notifyJobId(job)).toBe(`alert-${alert}-${refId}`);
    }
  });

  it('one silent period is one job id: the same last CREDIT gives the same refId', () => {
    const at = new Date('2026-11-04T07:00:00.000Z');
    expect(alertRef.cardSilent('c1', at)).toBe(alertRef.cardSilent('c1', new Date(at)));
    expect(alertRef.cardSilent('c1', at)).not.toBe(
      alertRef.cardSilent('c1', new Date(at.getTime() + 1000)),
    );
  });
});

describe('notifyJobId', () => {
  it('is stable per logical notification', () => {
    expect(notifyJobId({ kind: 'TOPUP_CREDITED', refId: 'p1' })).toBe('topup-p1');
    expect(notifyJobId({ kind: 'TOPUP_LATE_CREDITED', refId: 'p1' })).toBe('topup-p1');
    expect(notifyJobId({ kind: 'OWNER_ALERT', alert: 'chainBreak', refId: 'r9' })).toBe(
      'alert-chainBreak-r9',
    );
  });

  it('the schema refuses a ref the id builder would reject (hyphen, colon)', () => {
    for (const refId of ['a-b', 'a:b']) {
      expect(
        notifyJobSchema.safeParse({ kind: 'OWNER_ALERT', alert: 'noMatch', refId }).success,
      ).toBe(false);
    }
  });
});

describe('foreignChat alert ref (B2)', () => {
  it('one ref per source per hour, read back to its source', () => {
    const at = new Date('2030-05-03T10:59:59.999Z');
    const ref = alertRef.foreignChat('HUMO_BOT', at);
    expect(ref).toBe(`HUMO_BOT_${String(Math.floor(at.getTime() / 3_600_000))}`);
    expect(alertRef.foreignChat('HUMO_BOT', new Date('2030-05-03T10:00:00.000Z'))).toBe(ref);
    expect(parseForeignChatAlertRef(ref)).toBe('HUMO_BOT');
    expect(parseForeignChatAlertRef(alertRef.foreignChat('UZCARD_BOT', at))).toBe('UZCARD_BOT');
  });

  it('anything else is not a foreignChat ref', () => {
    for (const ref of ['HUMO_BOT_', 'OTHER_BOT_1', 'HUMO_BOT_1x', 'cm3abc']) {
      expect(parseForeignChatAlertRef(ref)).toBeNull();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { FULFILLMENT_ALERT_KINDS } from './fulfillment/fulfillment-alerts';
import { ALERT_KINDS } from './payments/bank-feed';
import {
  LISTENER_STOP_REASONS,
  NOTIFY_JOB_NAME,
  NOTIFY_KINDS,
  ORDER_NOTIFY_KINDS,
  OwnerAlertKindSchema,
  alertRef,
  notifyJobId,
  notifyJobSchema,
  ownerAlertOutboxJobId,
  parseBankChatAnomalyRef,
  parseForeignChatAlertRef,
  parseListenerDownRef,
  parseListenerStoppedRef,
} from './notify';

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

describe('listener alert refs (D-52)', () => {
  const at = new Date('2030-05-03T10:30:00.000Z');
  const hour = String(Math.floor(at.getTime() / 3_600_000));

  it('listenerDown carries the outage start and the hour; read back to the start', () => {
    const since = new Date('2030-05-03T10:20:00.000Z');
    const ref = alertRef.listenerDown(since, at);
    expect(ref).toBe(`${String(since.getTime())}_${hour}`);
    expect(
      notifyJobSchema.safeParse({ kind: 'OWNER_ALERT', alert: 'listenerDown', refId: ref }).success,
    ).toBe(true);
    expect(parseListenerDownRef(ref)).toEqual(since);
    expect(parseListenerDownRef(hour)).toBeNull();
  });

  it('listenerStopped: one per reason per hour', () => {
    for (const reason of LISTENER_STOP_REASONS) {
      expect(parseListenerStoppedRef(alertRef.listenerStopped(reason, at))).toBe(reason);
    }
    for (const ref of ['OTHER_1', 'REVOKED_', 'REVOKED_1x', hour]) {
      expect(parseListenerStoppedRef(ref)).toBeNull();
    }
  });

  it('bankChatAnomaly: source, reason and the hour (one alert an hour per source and reason, M-B)', () => {
    const ref = alertRef.bankChatAnomaly('UZCARD_BOT', 'FOREIGN_SENDER', at);
    expect(ref).toBe(`UZCARD_BOT_FOREIGN_SENDER_${hour}`);
    const sameHour = new Date(at.getTime() + 29 * 60_000);
    expect(alertRef.bankChatAnomaly('UZCARD_BOT', 'FOREIGN_SENDER', sameHour)).toBe(ref);
    expect(parseBankChatAnomalyRef(ref)).toEqual({
      source: 'UZCARD_BOT',
      reason: 'FOREIGN_SENDER',
    });
    for (const bad of ['HUMO_BOT_EDITED_1', 'X_OUTGOING_1', 'HUMO_BOT_OUTGOING_']) {
      expect(parseBankChatAnomalyRef(bad)).toBeNull();
    }
  });

  it('accountBound: the hour of the first binding (D-52 r2, L-B)', () => {
    expect(alertRef.accountBound(at)).toBe(hour);
    const job = { kind: 'OWNER_ALERT', alert: 'accountBound', refId: hour };
    expect(notifyJobSchema.safeParse(job).success).toBe(true);
  });
});

describe('ownerAlertOutboxJobId (D-53)', () => {
  const job = { kind: 'OWNER_ALERT', alert: 'chainBreak', refId: 'r9' } as const;

  it('is the alert id plus the recipient: stable, one per partner', () => {
    expect(ownerAlertOutboxJobId(job, '111111111')).toBe('alert-chainBreak-r9-111111111');
    expect(ownerAlertOutboxJobId(job, '111111111')).toBe(ownerAlertOutboxJobId(job, '111111111'));
    expect(ownerAlertOutboxJobId(job, '222222222')).not.toBe(
      ownerAlertOutboxJobId(job, '111111111'),
    );
  });

  it('fits the longest ref and the longest chat id', () => {
    const long = { ...job, refId: 'a'.repeat(64) };
    expect(() => ownerAlertOutboxJobId(long, '9'.repeat(20))).not.toThrow();
  });
});

describe('order notifications (phase 5)', () => {
  it('the four kinds are part of NOTIFY_KINDS and each takes an order id and nothing else', () => {
    expect([...ORDER_NOTIFY_KINDS]).toEqual([
      'ORDER_ACCEPTED',
      'ORDER_DELIVERED',
      'ORDER_REVIEW',
      'ORDER_REFUNDED',
    ]);
    for (const kind of ORDER_NOTIFY_KINDS) {
      expect(NOTIFY_KINDS).toContain(kind);
      expect(notifyJobSchema.safeParse({ kind, refId: 'cm0order1' }).success).toBe(true);
      // The API reads the owner and the language from the order: no user, no amount, no text.
      for (const extra of [{ userId: 'u1' }, { amountTiyin: '1' }, { text: 'x' }]) {
        expect(notifyJobSchema.safeParse({ kind, refId: 'cm0order1', ...extra }).success).toBe(
          false,
        );
      }
      expect(notifyJobSchema.safeParse({ kind }).success).toBe(false);
      expect(notifyJobSchema.safeParse({ kind, refId: 'a-b' }).success).toBe(false);
    }
  });

  it('every NOTIFY_KINDS entry is accepted by the schema (no kind without a shape)', () => {
    for (const kind of NOTIFY_KINDS) {
      const job =
        kind === 'OWNER_ALERT' ? { kind, alert: 'chainBreak', refId: 'r1' } : { kind, refId: 'r1' };
      expect(notifyJobSchema.safeParse(job).success, kind).toBe(true);
    }
  });

  it('one message per order and event: the job id is order-<id>-<event>', () => {
    const id = 'cm0order1';
    expect(notifyJobId({ kind: 'ORDER_ACCEPTED', refId: id })).toBe('order-cm0order1-accepted');
    expect(notifyJobId({ kind: 'ORDER_DELIVERED', refId: id })).toBe('order-cm0order1-delivered');
    expect(notifyJobId({ kind: 'ORDER_REVIEW', refId: id })).toBe('order-cm0order1-review');
    expect(notifyJobId({ kind: 'ORDER_REFUNDED', refId: id })).toBe('order-cm0order1-refunded');
    const ids = new Set(ORDER_NOTIFY_KINDS.map((kind) => notifyJobId({ kind, refId: id })));
    expect(ids.size).toBe(ORDER_NOTIFY_KINDS.length);
  });

  it('an order id and a payment id never share a job id', () => {
    expect(notifyJobId({ kind: 'TOPUP_CREDITED', refId: 'x1' })).not.toBe(
      notifyJobId({ kind: 'ORDER_ACCEPTED', refId: 'x1' }),
    );
  });
});

describe('OwnerAlertKind', () => {
  it('is the bank-feed alerts plus the fulfillment alerts', () => {
    for (const alert of [...ALERT_KINDS, ...FULFILLMENT_ALERT_KINDS]) {
      expect(OwnerAlertKindSchema.safeParse(alert).success, alert).toBe(true);
      expect(
        notifyJobSchema.safeParse({ kind: 'OWNER_ALERT', alert, refId: 'r1' }).success,
        alert,
      ).toBe(true);
    }
    expect(OwnerAlertKindSchema.safeParse('boom').success).toBe(false);
  });

  it('a fulfillment alert has an owner-alert job id like any other', () => {
    const job = { kind: 'OWNER_ALERT', alert: 'needsReview', refId: 'cm0order1' } as const;
    expect(notifyJobId(job)).toBe('alert-needsReview-cm0order1');
    expect(ownerAlertOutboxJobId(job, '111')).toBe('alert-needsReview-cm0order1-111');
  });
});

describe('NOTIFY_JOB_NAME', () => {
  it('is the one job name the API consumer and every producer share', () => {
    expect(NOTIFY_JOB_NAME).toBe('notify');
  });
});

import { describe, expect, it } from 'vitest';
import { FULFILLMENT_ALERT_KINDS } from './fulfillment/fulfillment-alerts';
import { ALERT_KINDS } from './payments/bank-feed';
import { alertRef, notifyJobId, notifyJobSchema, refIdSubject } from './notify';
import {
  CRITICAL_OWNER_ALERTS,
  FULFILLMENT_ALERT_PARAMS,
  HELD_REASON_LABEL_KEYS,
  TG_OUTBOX_PRIORITY,
  ownerAlertPriority,
  parseWorkerDownRef,
  shortTonAddress,
} from './notify-fulfillment';
import { ORDER_STATUS_REASONS } from './orders/order-status-reason';

const HEX = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0abcd';

describe('FULFILLMENT_ALERT_PARAMS', () => {
  it('declares every fulfillment alert kind and nothing else', () => {
    expect(Object.keys(FULFILLMENT_ALERT_PARAMS).sort()).toEqual(
      [...FULFILLMENT_ALERT_KINDS].sort(),
    );
  });

  it('never declares a secret-shaped or full-value placeholder', () => {
    const all = Object.values(FULFILLMENT_ALERT_PARAMS).flat();
    for (const name of all) {
      expect(name).not.toMatch(/cookie|mnemonic|key|secret|hash|boc|address_full|phone/i);
    }
  });
});

describe('phase 5 S9 alerts (D-64 (6), (7))', () => {
  const S9_KINDS = ['orderNoPurchase', 'reconcileGuardRefused', 'tonLateConfirmed'] as const;

  it('declares the three new kinds with their placeholders', () => {
    for (const kind of S9_KINDS) expect(FULFILLMENT_ALERT_KINDS).toContain(kind);
    expect(FULFILLMENT_ALERT_PARAMS.orderNoPurchase).toEqual(['number', 'product', 'ref']);
    expect(FULFILLMENT_ALERT_PARAMS.reconcileGuardRefused).toEqual(['number', 'status', 'ref']);
    expect(FULFILLMENT_ALERT_PARAMS.tonLateConfirmed).toEqual([
      'number',
      'seqno',
      'amount',
      'to',
      'status',
      'ref',
    ]);
  });

  it('tonSeqnoUnmatched now names the order # and the amount (CR m9)', () => {
    expect(FULFILLMENT_ALERT_PARAMS.tonSeqnoUnmatched).toEqual([
      'number',
      'seqno',
      'amount',
      'ref',
    ]);
  });

  it.each(S9_KINDS)('%s is critical: it jumps the tg-outbox queue', (kind) => {
    expect(CRITICAL_OWNER_ALERTS).toContain(kind);
    expect(ownerAlertPriority(kind)).toBe('critical');
  });
});

describe('HELD_REASON_LABEL_KEYS', () => {
  it('labels only real order status reasons', () => {
    for (const reason of Object.keys(HELD_REASON_LABEL_KEYS)) {
      expect(ORDER_STATUS_REASONS).toContain(reason);
    }
  });
});

describe('workerDown ref', () => {
  it('round-trips the last time the heartbeat was seen', () => {
    const seen = new Date('2030-01-01T08:58:00.000Z');
    expect(parseWorkerDownRef(alertRef.workerDown(seen))).toEqual(seen);
  });

  it.each(['', 'abc', '12_34', '1'.repeat(16), '-5'])('rejects %j', (ref) => {
    expect(parseWorkerDownRef(ref)).toBeNull();
  });
});

describe('bankfeedDown (D-76 (4))', () => {
  const seen = new Date('2030-01-01T08:58:00.000Z');

  it('round-trips the last sighting and fits a notify job', () => {
    const refId = alertRef.bankfeedDown(seen);
    expect(parseWorkerDownRef(refId)).toEqual(seen);
    expect(
      notifyJobSchema.safeParse({ kind: 'OWNER_ALERT', alert: 'bankfeedDown', refId }).success,
    ).toBe(true);
  });

  it('prints only the minutes, and is critical', () => {
    expect(FULFILLMENT_ALERT_PARAMS.bankfeedDown).toEqual(['minutes']);
    expect(ownerAlertPriority('bankfeedDown')).toBe('critical');
  });

  it('the same outage start under workerDown is another notify job id', () => {
    const refId = alertRef.bankfeedDown(seen);
    expect(refId).toBe(alertRef.workerDown(seen));
    expect(notifyJobId({ kind: 'OWNER_ALERT', alert: 'bankfeedDown', refId })).not.toBe(
      notifyJobId({ kind: 'OWNER_ALERT', alert: 'workerDown', refId }),
    );
  });
});

describe('queueStuck ref', () => {
  const addedAt = new Date('2030-01-01T09:00:00.000Z');

  it('is the job id and the add time; the order id reads back and it fits a notify job', () => {
    const ref = alertRef.queueStuck('cmorder1abc', addedAt);
    expect(ref).toBe(`cmorder1abc_${String(addedAt.getTime())}`);
    expect(refIdSubject(ref)).toBe('cmorder1abc');
    expect(
      notifyJobSchema.safeParse({ kind: 'OWNER_ALERT', alert: 'queueStuck', refId: ref }).success,
    ).toBe(true);
  });

  it('the same order added again later is another ref', () => {
    expect(alertRef.queueStuck('o1', addedAt)).not.toBe(
      alertRef.queueStuck('o1', new Date(addedAt.getTime() + 1)),
    );
  });

  it.each([undefined, '', 'a:b', 'a-b', 'a_b', 'x'.repeat(41)])(
    'never copies an odd job id %j into the ref',
    (jobId) => {
      expect(alertRef.queueStuck(jobId, addedAt)).toBe(`job_${String(addedAt.getTime())}`);
    },
  );
});

describe('critical owner alerts (tg-outbox priority, audit M-1 (b))', () => {
  it('lists only real alert kinds, each once', () => {
    const all: readonly string[] = [...ALERT_KINDS, ...FULFILLMENT_ALERT_KINDS];
    for (const kind of CRITICAL_OWNER_ALERTS) expect(all).toContain(kind);
    expect(new Set(CRITICAL_OWNER_ALERTS).size).toBe(CRITICAL_OWNER_ALERTS.length);
  });

  it('puts the wallet, review, stopped-fulfillment and bank-feed signals first, floods behind', () => {
    for (const kind of [
      'tonWalletCompromised',
      'workerDown',
      'queueStuck',
      'needsReview',
      'foreignChat',
      'bankChatAnomaly',
      'listenerStopped',
      'listenerDown',
    ] as const) {
      expect(ownerAlertPriority(kind)).toBe('critical');
    }
    for (const kind of ['held', 'tonDailyLimit', 'tonLowBalance', 'unrecognized'] as const) {
      expect(ownerAlertPriority(kind)).toBe('normal');
    }
  });

  it('every priority is a real BullMQ priority (1 = highest, 0 would mean none)', () => {
    expect(TG_OUTBOX_PRIORITY.critical).toBeLessThan(TG_OUTBOX_PRIORITY.normal);
    for (const value of Object.values(TG_OUTBOX_PRIORITY)) {
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(2_097_151);
    }
  });
});

describe('shortTonAddress', () => {
  it('keeps the workchain and four hex digits at each end of a raw address', () => {
    expect(shortTonAddress(`0:${HEX}`)).toBe('0:a1b2…abcd');
    expect(shortTonAddress(`-1:${HEX}`)).toBe('-1:a1b2…abcd');
  });

  it('never returns the whole address', () => {
    const out = shortTonAddress(`0:${HEX}`);
    expect(out).not.toContain(HEX);
    expect(out.length).toBeLessThan(16);
  });

  it('shortens a user-friendly address by characters', () => {
    const friendly = 'EQAAbbbbCCCCddddEEEEffffGGGGhhhhIIIIjjjjKK__wxyz';
    expect(shortTonAddress(friendly)).toBe('EQAA…wxyz');
  });

  it('prints ? for something too short to shorten', () => {
    expect(shortTonAddress('0:abc')).toBe('?');
    expect(shortTonAddress('')).toBe('?');
  });
});

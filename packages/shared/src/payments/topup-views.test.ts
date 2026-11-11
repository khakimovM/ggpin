import { describe, expect, it } from 'vitest';
import {
  CancelTopupIntentBodySchema,
  CancelTopupIntentResponseSchema,
  IdempotencyConflictDetailsSchema,
  IntentListQuerySchema,
  IntentParamsSchema,
  PayLinkBodySchema,
  PayLinkResponseSchema,
  PayViewParamsSchema,
  PayViewSchema,
  PaymentMethodsResponseSchema,
  TOPUP_DEFAULTS,
  TopupAlreadyPendingDetailsSchema,
  TopupAmountOutOfRangeDetailsSchema,
  TopupCardViewSchema,
} from './topup-schemas';

// Built, not spelled out: a 43-character base64url literal looks like a secret to scanners.
const TOKEN = `${'Tk'.repeat(21)}x`;
const CARD = { bank: 'HUMO', number: '0000000000000000', holderName: 'TEST HOLDER' } as const;
const EXPIRES = '2026-11-04T10:30:00.000Z';

describe('TopupCardViewSchema', () => {
  it('takes 16 digits without separators', () => {
    expect(TopupCardViewSchema.safeParse(CARD).success).toBe(true);
    for (const number of ['0000 0000 0000 0000', '000000000000000', '00000000000000000', 'abcd']) {
      expect(TopupCardViewSchema.safeParse({ ...CARD, number }).success).toBe(false);
    }
  });
});

describe('PayViewSchema (capability endpoint)', () => {
  const view = {
    intentId: 'cm0intent1',
    status: 'PENDING',
    baseAmountTiyin: '2000000',
    payAmountTiyin: '2034100',
    card: CARD,
    expiresAt: EXPIRES,
    ownerHint: 'S***r',
    currency: 'UZS',
  };

  it('accepts the display data only', () => {
    expect(PayViewSchema.safeParse(view).success).toBe(true);
    expect(PayViewSchema.safeParse({ ...view, status: 'PAID', card: null }).success).toBe(true);
  });

  it('ownerHint is a masked hint or null, never a name', () => {
    expect(PayViewSchema.safeParse({ ...view, ownerHint: null }).success).toBe(true);
    expect(PayViewSchema.safeParse({ ...view, ownerHint: 'S***' }).success).toBe(true);
    for (const ownerHint of ['Sardor', 'Sardor Karimov', '', 'S***rd']) {
      expect(PayViewSchema.safeParse({ ...view, ownerHint }).success, ownerHint).toBe(false);
    }
    const { ownerHint: _omitted, ...withoutHint } = view;
    expect(PayViewSchema.safeParse(withoutHint).success).toBe(false);
  });

  it('never carries user, wallet or ledger data, and hides the card once not PENDING', () => {
    for (const extra of [{ userId: 'u1' }, { balanceTiyin: '1' }, { username: 'x' }]) {
      expect(PayViewSchema.safeParse({ ...view, ...extra }).success).toBe(false);
    }
    expect(PayViewSchema.safeParse({ ...view, status: 'PAID' }).success).toBe(false);
  });
});

describe('other topup shapes', () => {
  it('IntentListQuerySchema defaults and bounds limit, rejects unknown keys', () => {
    expect(IntentListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(IntentListQuerySchema.parse({ status: 'PAID', limit: '100' })).toEqual({
      status: 'PAID',
      limit: 100,
    });
    for (const bad of [{ limit: '101' }, { limit: '0' }, { status: 'X' }, { page: '2' }]) {
      expect(IntentListQuerySchema.safeParse(bad).success).toBe(false);
    }
  });

  it('IntentParamsSchema and PayViewParamsSchema take a resource id only', () => {
    expect(IntentParamsSchema.safeParse({ id: 'cm0intent1' }).success).toBe(true);
    expect(IntentParamsSchema.safeParse({ id: '../x' }).success).toBe(false);
    expect(PayViewParamsSchema.safeParse({ intentId: 'cm0intent1' }).success).toBe(true);
    // Any failure of the pay endpoint is the same 404, so a strange id is not a 400 here.
    expect(PayViewParamsSchema.safeParse({ intentId: '../x' }).success).toBe(true);
    expect(PayViewParamsSchema.safeParse({ intentId: 'a'.repeat(129) }).success).toBe(false);
  });

  it('cancel and pay-link bodies are empty objects', () => {
    expect(CancelTopupIntentBodySchema.safeParse({}).success).toBe(true);
    expect(CancelTopupIntentBodySchema.safeParse({ reason: 'x' }).success).toBe(false);
    expect(PayLinkBodySchema.safeParse({}).success).toBe(true);
    expect(PayLinkBodySchema.safeParse({ a: 1 }).success).toBe(false);
    expect(
      CancelTopupIntentResponseSchema.safeParse({ intentId: 'i1', status: 'CANCELLED' }).success,
    ).toBe(true);
    expect(
      PayLinkResponseSchema.safeParse({
        redirectUrl: `https://ggpin.example/pay/i#t=${TOKEN}`,
        expiresAt: EXPIRES,
      }).success,
    ).toBe(true);
  });

  it('PaymentMethodsResponseSchema matches the documented example', () => {
    const methods = [
      {
        code: 'P2P_CARD',
        available: true,
        banks: [
          { bank: 'HUMO', available: true },
          { bank: 'UZCARD', available: false },
        ],
        minTiyin: String(TOPUP_DEFAULTS.MIN_TIYIN),
        maxTiyin: String(TOPUP_DEFAULTS.MAX_TIYIN),
        stepTiyin: String(TOPUP_DEFAULTS.STEP_TIYIN),
      },
    ];
    expect(PaymentMethodsResponseSchema.safeParse(methods).success).toBe(true);
    expect(PaymentMethodsResponseSchema.safeParse([{ ...methods[0], code: 'CLICK' }]).success).toBe(
      false,
    );
  });

  it('error details have the documented shapes', () => {
    const range = { min: '500000', max: '200000000', step: '100000' };
    expect(TopupAmountOutOfRangeDetailsSchema.safeParse(range).success).toBe(true);
    for (const reason of ['DAILY_LIMIT', 'NEW_ACCOUNT_DAILY_LIMIT']) {
      expect(TopupAmountOutOfRangeDetailsSchema.safeParse({ ...range, reason }).success).toBe(true);
    }
    expect(TopupAmountOutOfRangeDetailsSchema.safeParse({ ...range, reason: 'X' }).success).toBe(
      false,
    );
    expect(IdempotencyConflictDetailsSchema.safeParse({ intentId: 'i1' }).success).toBe(true);
    expect(IdempotencyConflictDetailsSchema.safeParse({}).success).toBe(false);
    expect(TopupAlreadyPendingDetailsSchema.safeParse({ intentId: 'i1' }).success).toBe(true);
    expect(TopupAlreadyPendingDetailsSchema.safeParse({}).success).toBe(false);
  });

  it('TOPUP_DEFAULTS match the owner decisions of 2026-11-04 (D-37 (2), (7))', () => {
    expect(TOPUP_DEFAULTS.MIN_TIYIN).toBe(500_000n);
    expect(TOPUP_DEFAULTS.MAX_TIYIN).toBe(200_000_000n);
    expect(TOPUP_DEFAULTS.STEP_TIYIN).toBe(100_000n);
    expect(TOPUP_DEFAULTS.SUFFIX_MAX_SOM).toBe(999);
    expect(TOPUP_DEFAULTS.INTENT_TTL_SEC).toBe(30 * 60);
    expect(TOPUP_DEFAULTS.LATE_GRACE_SEC).toBe(24 * 60 * 60);
    expect(TOPUP_DEFAULTS.CAPACITY_HOLD_SEC).toBe(60 * 60); // D-42 (1)
    expect(TOPUP_DEFAULTS.NEW_ACCOUNT_AGE_SEC).toBe(7 * 24 * 60 * 60);
    expect(TOPUP_DEFAULTS.NEW_ACCOUNT_DAILY_MAX_TIYIN).toBe(50_000_000n);
    expect(TOPUP_DEFAULTS.DAILY_MAX_TIYIN).toBe(500_000_000n);
    expect(TOPUP_DEFAULTS.MAX_RESERVED_PER_USER).toBe(3);
    expect(TOPUP_DEFAULTS.DAILY_CREATE_LIMIT).toBe(10);
  });
});

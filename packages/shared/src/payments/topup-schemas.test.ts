import { describe, expect, it } from 'vitest';
import {
  CreateTopupIntentBodySchema,
  TopupIntentCreatedSchema,
  TopupIntentSchema,
} from './topup-schemas';

// Built, not spelled out: a 43-character base64url literal looks like a secret to scanners.
const TOKEN = `${'Tk'.repeat(21)}x`;
const CARD = { bank: 'HUMO', number: '0000000000000000', holderName: 'TEST HOLDER' } as const;
const EXPIRES = '2026-11-04T10:30:00.000Z';

const createBody = { provider: 'P2P_CARD', amountTiyin: '2000000', purpose: 'TOPUP' };

describe('CreateTopupIntentBodySchema', () => {
  it('accepts the documented body, with and without a bank', () => {
    expect(CreateTopupIntentBodySchema.safeParse(createBody).success).toBe(true);
    expect(CreateTopupIntentBodySchema.safeParse({ ...createBody, bank: 'UZCARD' }).success).toBe(
      true,
    );
  });

  it('rejects TOPUP_AND_BUY until phase 5 (400, not silently ignored)', () => {
    expect(
      CreateTopupIntentBodySchema.safeParse({ ...createBody, purpose: 'TOPUP_AND_BUY' }).success,
    ).toBe(false);
  });

  it('rejects a quoteId, any unknown key and a missing field (.strict())', () => {
    expect(CreateTopupIntentBodySchema.safeParse({ ...createBody, quoteId: 'q1' }).success).toBe(
      false,
    );
    expect(CreateTopupIntentBodySchema.safeParse({ ...createBody, userId: 'u1' }).success).toBe(
      false,
    );
    const { purpose: _purpose, ...withoutPurpose } = createBody;
    expect(CreateTopupIntentBodySchema.safeParse(withoutPurpose).success).toBe(false);
  });

  it('rejects another provider and another bank', () => {
    expect(
      CreateTopupIntentBodySchema.safeParse({ ...createBody, provider: 'CLICK' }).success,
    ).toBe(false);
    expect(CreateTopupIntentBodySchema.safeParse({ ...createBody, bank: 'VISA' }).success).toBe(
      false,
    );
  });

  it('takes money only as a decimal string of tiyin', () => {
    for (const amountTiyin of [2000000, '20000.50', '-1', '01', '', '1e6', ' 5']) {
      expect(CreateTopupIntentBodySchema.safeParse({ ...createBody, amountTiyin }).success).toBe(
        false,
      );
    }
  });

  it('does not judge the step or range: that is a 422 with details, not a 400', () => {
    for (const amountTiyin of ['1', '1234567', '999999999999']) {
      expect(CreateTopupIntentBodySchema.safeParse({ ...createBody, amountTiyin }).success).toBe(
        true,
      );
    }
  });
});

const intent = {
  intentId: 'cm0intent1',
  status: 'PENDING',
  baseAmountTiyin: '2000000',
  payAmountTiyin: '2034100',
  card: CARD,
  expiresAt: EXPIRES,
  paidAt: null,
  creditedTiyin: null,
  currency: 'UZS',
};

describe('TopupIntentCreatedSchema', () => {
  const created = {
    intentId: 'cm0intent1',
    status: 'PENDING',
    baseAmountTiyin: '2000000',
    payAmountTiyin: '2034100',
    card: CARD,
    expiresAt: EXPIRES,
    redirectUrl: `https://ggpin.example/pay/cm0intent1#t=${TOKEN}`,
    currency: 'UZS',
  };

  it('accepts the documented 201 body', () => {
    expect(TopupIntentCreatedSchema.safeParse(created).success).toBe(true);
  });

  it('requires a unique extra of whole 1..999 so‘m on top of the base', () => {
    for (const payAmountTiyin of ['2000000', '2000050', '2100000', '2034150', '1999900']) {
      expect(TopupIntentCreatedSchema.safeParse({ ...created, payAmountTiyin }).success).toBe(
        false,
      );
    }
    for (const payAmountTiyin of ['2000100', '2099900']) {
      expect(TopupIntentCreatedSchema.safeParse({ ...created, payAmountTiyin }).success).toBe(true);
    }
  });

  it('takes the token in the URL fragment, not in the query (D-37 (15))', () => {
    const query = `https://ggpin.example/pay/cm0intent1?t=${TOKEN}`;
    expect(TopupIntentCreatedSchema.safeParse({ ...created, redirectUrl: query }).success).toBe(
      false,
    );
  });

  it('is PENDING with a card, and carries no extra keys', () => {
    expect(TopupIntentCreatedSchema.safeParse({ ...created, status: 'PAID' }).success).toBe(false);
    expect(TopupIntentCreatedSchema.safeParse({ ...created, userId: 'u1' }).success).toBe(false);
  });
});

describe('TopupIntentSchema', () => {
  it('accepts a pending intent with the card', () => {
    expect(TopupIntentSchema.safeParse(intent).success).toBe(true);
  });

  it('accepts a paid intent: no card, credited amount set', () => {
    const paid = {
      ...intent,
      status: 'PAID',
      card: null,
      paidAt: '2026-11-04T10:05:00.000Z',
      creditedTiyin: '2034100',
    };
    expect(TopupIntentSchema.safeParse(paid).success).toBe(true);
  });

  it('paidAt and creditedTiyin are set exactly when PAID', () => {
    const paidAt = '2026-11-04T10:05:00.000Z';
    const expired = { ...intent, status: 'EXPIRED', card: null };
    expect(TopupIntentSchema.safeParse({ ...expired, paidAt }).success).toBe(false);
    expect(TopupIntentSchema.safeParse({ ...expired, creditedTiyin: '2034100' }).success).toBe(
      false,
    );
    const paid = { ...intent, status: 'PAID', card: null, paidAt, creditedTiyin: '2034100' };
    expect(TopupIntentSchema.safeParse({ ...paid, paidAt: null }).success).toBe(false);
    expect(TopupIntentSchema.safeParse({ ...paid, creditedTiyin: null }).success).toBe(false);
  });

  it('a malformed money string is a validation failure, never an exception', () => {
    for (const payAmountTiyin of ['1.5', '', 'abc', '-1', '2034100.00']) {
      const result = TopupIntentSchema.safeParse({ ...intent, payAmountTiyin });
      expect(result.success, payAmountTiyin).toBe(false);
    }
    expect(TopupIntentSchema.safeParse({ ...intent, baseAmountTiyin: '1.5' }).success).toBe(false);
  });

  it('shows the card exactly while PENDING', () => {
    expect(TopupIntentSchema.safeParse({ ...intent, status: 'EXPIRED' }).success).toBe(false);
    expect(TopupIntentSchema.safeParse({ ...intent, card: null }).success).toBe(false);
    expect(TopupIntentSchema.safeParse({ ...intent, status: 'EXPIRED', card: null }).success).toBe(
      true,
    );
  });

  it('rejects a bad suffix and an unknown status', () => {
    expect(TopupIntentSchema.safeParse({ ...intent, payAmountTiyin: '2000000' }).success).toBe(
      false,
    );
    expect(TopupIntentSchema.safeParse({ ...intent, status: 'DONE' }).success).toBe(false);
  });
});

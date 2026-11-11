import { PayLinkUrlSchema, buildPayLink } from '@repo/shared';
import { toPayView } from '../entities/pay-view.mapper';
import { toTopupIntent, toTopupIntentCreated } from '../entities/intent.mapper';
import type { IntentWithCard } from '../topup-intents.repository';
import { cardRow } from './payments.fixtures';

const TOKEN = 'T'.repeat(43);

function intent(overrides: Partial<IntentWithCard> = {}): IntentWithCard {
  return {
    id: 'intent_1',
    userId: 'user_secret_id',
    provider: 'P2P_CARD',
    amountTiyin: 2_034_100n,
    status: 'PENDING',
    purpose: 'TOPUP',
    quoteId: null,
    idempotencyKey: 'idem-key-secret',
    requestHash: 'request-hash-secret',
    expiresAt: new Date('2026-11-05T10:30:00.000Z'),
    cardId: 'card_a',
    baseAmountTiyin: 2_000_000n,
    paidAt: null,
    reservedUntil: new Date('2026-11-06T10:30:00.000Z'),
    payTokenHash: 'f'.repeat(64),
    createdAt: new Date('2026-11-05T10:00:00.000Z'),
    updatedAt: new Date('2026-11-05T10:00:00.000Z'),
    card: cardRow(),
    ...overrides,
  };
}

describe('intent mappers', () => {
  it('201 body: the contract keys only, money as strings, short holder name, the pay link', () => {
    const link = buildPayLink('http://localhost:3000', 'intent_1', TOKEN, 'ru');
    const body = toTopupIntentCreated(intent(), link);
    expect(Object.keys(body).sort()).toEqual(
      [
        'intentId',
        'status',
        'baseAmountTiyin',
        'payAmountTiyin',
        'card',
        'expiresAt',
        'redirectUrl',
        'currency',
      ].sort(),
    );
    expect(body.card).toEqual({ bank: 'HUMO', number: cardRow().pan, holderName: 'TESTOV S.' });
    expect(body.payAmountTiyin).toBe('2034100');
    expect(PayLinkUrlSchema.parse(body.redirectUrl)).toBe(
      `http://localhost:3000/pay/intent_1?locale=ru#t=${TOKEN}`,
    );
    const text = JSON.stringify(body);
    for (const secret of [
      'user_secret_id',
      'idem-key-secret',
      'request-hash-secret',
      'TESTOV SINOV',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('GET intent: card only while PENDING; paidAt and creditedTiyin exactly when PAID', () => {
    expect(toTopupIntent(intent()).card).not.toBeNull();
    const paidAt = new Date('2026-11-05T10:05:00.000Z');
    const paid = toTopupIntent(intent({ status: 'PAID', paidAt }));
    expect(paid).toMatchObject({
      status: 'PAID',
      card: null,
      paidAt: paidAt.toISOString(),
      creditedTiyin: '2034100',
    });
    for (const status of ['EXPIRED', 'CANCELLED'] as const) {
      expect(toTopupIntent(intent({ status }))).toMatchObject({
        card: null,
        paidAt: null,
        creditedTiyin: null,
      });
    }
  });

  it('§2.8 pay view: exactly the allowed keys (snapshot), masked owner, no user data', () => {
    const view = toPayView(intent(), { firstName: 'Sardor', username: 'sardor_secret' });
    expect(view).toMatchInlineSnapshot(`
      {
        "baseAmountTiyin": "2000000",
        "card": {
          "bank": "HUMO",
          "holderName": "TESTOV S.",
          "number": "${cardRow().pan}",
        },
        "currency": "UZS",
        "expiresAt": "2026-11-05T10:30:00.000Z",
        "intentId": "intent_1",
        "ownerHint": "S***r",
        "payAmountTiyin": "2034100",
        "status": "PENDING",
      }
    `);
    expect(JSON.stringify(view)).not.toContain('sardor_secret');
    expect(
      toPayView(intent({ status: 'PAID', paidAt: new Date() }), {
        firstName: null,
        username: null,
      }),
    ).toMatchObject({ card: null, ownerHint: null });
  });
});

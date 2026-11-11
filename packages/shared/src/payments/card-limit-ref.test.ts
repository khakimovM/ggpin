import { describe, expect, it } from 'vitest';
import { notifyJobId, notifyJobSchema } from '../notify';
import { cardLimitAlertRef, parseCardLimitAlertRef, type CardLimitRef } from './card-limit-ref';

const CUID = 'cm3abcdefghijklmnopqrstu'; // 24 characters, like Prisma cuid(2)
const MAX = 9_223_372_036_854_775_807n;

describe('card-limit alert refs (D-45)', () => {
  it('carries the limits, so a raised limit is a new alert and the same limits are one', () => {
    const card: CardLimitRef = { cardId: CUID, receiveLimitTiyin: 36n, monthlyLimitTiyin: null };
    expect(cardLimitAlertRef('cardFull', card)).toBe(`${CUID}_10`);
    expect(cardLimitAlertRef('cardNearLimit', card)).toBe(`${CUID}_80_10`);
    const raised = { ...card, receiveLimitTiyin: 37n };
    expect(cardLimitAlertRef('cardFull', raised)).not.toBe(cardLimitAlertRef('cardFull', card));
    const monthly = { ...card, monthlyLimitTiyin: 35n };
    expect(cardLimitAlertRef('cardFull', monthly)).toBe(`${CUID}_10_z`);
    expect(cardLimitAlertRef('cardNearLimit', monthly)).toBe(`${CUID}_80_10_z`);
  });

  it('round-trips, and the largest BIGINT limits with a cuid still fit the 64-char refId', () => {
    for (const alert of ['cardFull', 'cardNearLimit'] as const) {
      for (const card of [
        { cardId: CUID, receiveLimitTiyin: 1_000_000_000n, monthlyLimitTiyin: null },
        { cardId: CUID, receiveLimitTiyin: MAX, monthlyLimitTiyin: MAX },
        { cardId: 'a'.repeat(32), receiveLimitTiyin: MAX, monthlyLimitTiyin: MAX },
      ]) {
        const ref = cardLimitAlertRef(alert, card);
        expect(ref.length).toBeLessThanOrEqual(64);
        expect(parseCardLimitAlertRef(alert, ref)).toEqual(card);
        // The notify job schema and the outbox job id accept it.
        const job = notifyJobSchema.parse({ kind: 'OWNER_ALERT', alert, refId: ref });
        expect(notifyJobId(job)).toBe(`alert-${alert}-${ref}`);
      }
    }
  });

  it('refuses what it cannot represent', () => {
    const card = { cardId: CUID, receiveLimitTiyin: 1n, monthlyLimitTiyin: null };
    expect(() => cardLimitAlertRef('cardFull', { ...card, cardId: 'has_underscore' })).toThrow(
      'malformed card id',
    );
    expect(() => cardLimitAlertRef('cardFull', { ...card, cardId: 'a'.repeat(33) })).toThrow(
      'malformed card id',
    );
    expect(() => cardLimitAlertRef('cardFull', { ...card, receiveLimitTiyin: 0n })).toThrow(
      'out of range',
    );
    expect(() => cardLimitAlertRef('cardFull', { ...card, monthlyLimitTiyin: MAX + 1n })).toThrow(
      'out of range',
    );
  });

  it.each([
    ['cardFull', ''],
    ['cardFull', CUID],
    ['cardFull', `${CUID}_`],
    ['cardFull', `${CUID}_0`],
    ['cardFull', `${CUID}_01`],
    ['cardFull', `${CUID}_A`],
    ['cardFull', `${CUID}_1_2_3`],
    ['cardFull', `${CUID}_1_`],
    ['cardFull', `${CUID}_1t`.padEnd(70, '1')],
    ['cardFull', `${CUID}_1y2p0ij32e8e8`], // 2^63: one past BIGINT
    ['cardNearLimit', `${CUID}_10`],
    ['cardNearLimit', `${CUID}_79_10`],
    ['cardNearLimit', `${CUID}_80`],
    ['cardFull', `bad-id_10`],
  ] as const)('%s %s is not a ref', (alert, ref) => {
    expect(parseCardLimitAlertRef(alert, ref)).toBeNull();
  });
});

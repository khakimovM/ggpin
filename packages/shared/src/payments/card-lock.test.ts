import { describe, expect, it } from 'vitest';
import { cardReservedHighRef, parseCardReservedHighRef, topupCardLockKey } from './card-lock';

describe('topupCardLockKey', () => {
  it('is one fixed spelling per card (API and worker must lock the same key)', () => {
    expect(topupCardLockKey('cm3card0000000000000000001')).toBe(
      'topup-card:cm3card0000000000000000001',
    );
  });

  it.each(['', 'a:b', 'a b', 'x'.repeat(65), "c'; --"])('refuses a malformed id %j', (id) => {
    expect(() => topupCardLockKey(id)).toThrow('malformed card id');
  });
});

describe('cardReservedHighRef / parseCardReservedHighRef (D-42 (1))', () => {
  const card = 'cm3card0000000000000000001';

  it('one ref per card per clock hour', () => {
    const ref = cardReservedHighRef(card, new Date('2026-11-05T10:00:00.000Z'));
    expect(ref).toBe(`${card}_${String(Date.UTC(2026, 10, 5, 10) / 3_600_000)}`);
    expect(cardReservedHighRef(card, new Date('2026-11-05T10:59:59.999Z'))).toBe(ref);
    expect(cardReservedHighRef(card, new Date('2026-11-05T11:00:00.000Z'))).not.toBe(ref);
    expect(
      cardReservedHighRef('cm3card0000000000000000002', new Date('2026-11-05T10:00:00.000Z')),
    ).not.toBe(ref);
  });

  it('parses back the card and the start of the hour', () => {
    const now = new Date('2026-11-05T10:42:17.000Z');
    expect(parseCardReservedHighRef(cardReservedHighRef(card, now))).toEqual({
      cardId: card,
      hourStart: new Date('2026-11-05T10:00:00.000Z'),
    });
    // An id with an underscore: the hour is the digits after the LAST one.
    expect(parseCardReservedHighRef('a_1_7')).toEqual({
      cardId: 'a_1',
      hourStart: new Date(7 * 3_600_000),
    });
  });

  it.each(['', card, `${card}_`, `_123`, `${card}_12a`, `${card}-123`, `${'x'.repeat(60)}_12345`])(
    'parse refuses %j',
    (ref) => {
      expect(parseCardReservedHighRef(ref)).toBeNull();
    },
  );

  it('build refuses a malformed or too long card id', () => {
    const now = new Date('2026-11-05T10:00:00.000Z');
    expect(() => cardReservedHighRef('a:b', now)).toThrow('malformed card id');
    expect(() => cardReservedHighRef('x'.repeat(60), now)).toThrow('too long');
  });
});

import { TOPUP_CARD_STATUSES, type TopupCardStatus } from '@repo/shared';
import { AppError } from '../../../common/exceptions/app-error';
import {
  checkedActor,
  checkedBank,
  checkedHolderName,
  checkedLimit,
  checkedPan,
  checkedReason,
  luhnValid,
  newVerifyAmountTiyin,
} from '../card-admin.input';
import { assertCardTransition, canTransitionCard } from '../card-state';
import { syntheticPan, withLuhnDigit } from './payments.fixtures';

function fieldOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.details?.['field'];
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('card service input', () => {
  it('PAN: 16 digits with a valid Luhn digit; separators as typed are dropped', () => {
    expect(luhnValid('9999123456789019')).toBe(true); // synthetic 9999 prefix, never a real card
    expect(luhnValid('9999123456789010')).toBe(false);
    const pan = syntheticPan();
    expect(checkedPan(pan)).toBe(pan);
    expect(checkedPan(`${pan.slice(0, 4)} ${pan.slice(4, 8)}-${pan.slice(8)}`)).toBe(pan);
    const wrongDigit = `${pan.slice(0, 15)}${String((Number(pan[15]) + 1) % 10)}`;
    for (const bad of [wrongDigit, pan.slice(0, 15), `${pan}0`, 'abcd'.repeat(4), '']) {
      expect(fieldOf(() => checkedPan(bad))).toBe('pan');
    }
    expect(withLuhnDigit('999900000000001')).toHaveLength(16);
  });

  it('holder name: trimmed, single spaces, refused when invisible or too long', () => {
    expect(checkedHolderName('  TESTOV   SINOV ')).toBe('TESTOV SINOV');
    for (const bad of ['', '   ', '​​', 'A‮B', 'X'.repeat(65)]) {
      expect(fieldOf(() => checkedHolderName(bad))).toBe('holderName');
    }
  });

  it('limit is mandatory and positive (no global default, E-9)', () => {
    expect(checkedLimit('limitTiyin', 1n)).toBe(1n);
    expect(fieldOf(() => checkedLimit('limitTiyin', 0n))).toBe('limitTiyin');
    expect(fieldOf(() => checkedLimit('limitTiyin', -5n))).toBe('limitTiyin');
    expect(fieldOf(() => checkedLimit('limitTiyin', 2n ** 63n))).toBe('limitTiyin');
  });

  it('reason, operator, ip and bank are checked', () => {
    expect(checkedReason('  card blocked by the bank ')).toBe('card blocked by the bank');
    for (const bad of ['', '...', 'a‮b', 'x'.repeat(501)]) {
      expect(fieldOf(() => checkedReason(bad))).toBe('reason');
    }
    expect(checkedActor({ operator: 'owner', ip: '203.0.113.7' })).toEqual({
      operator: 'owner',
      ip: '203.0.113.7',
    });
    expect(fieldOf(() => checkedActor({ operator: ' owner' }))).toBe('operator');
    expect(fieldOf(() => checkedActor({ operator: 'owner', ip: 'not-an-ip' }))).toBe('ip');
    expect(checkedBank('UZCARD')).toBe('UZCARD');
    expect(fieldOf(() => checkedBank('VISA'))).toBe('bank');
  });

  it('the verification amount is 1 000 so‘m + 1..999 so‘m', () => {
    expect(newVerifyAmountTiyin(() => 0)).toBe(100_100n);
    expect(newVerifyAmountTiyin(() => 998)).toBe(199_900n);
    for (let i = 0; i < 100; i += 1) {
      const amount = newVerifyAmountTiyin();
      expect(amount >= 100_100n && amount <= 199_900n && amount % 100n === 0n).toBe(true);
    }
  });
});

describe('card status graph (docs/05 §2; RETIRED final like the DB guard)', () => {
  const allowed: Record<TopupCardStatus, TopupCardStatus[]> = {
    VERIFYING: ['ACTIVE', 'RETIRED'],
    ACTIVE: ['FULL', 'DRAINING', 'RETIRED'],
    FULL: ['ACTIVE', 'DRAINING', 'RETIRED'],
    DRAINING: ['RETIRED'],
    RETIRED: [],
  };

  it.each(TOPUP_CARD_STATUSES.flatMap((from) => TOPUP_CARD_STATUSES.map((to) => [from, to])))(
    '%s -> %s',
    (from, to) => {
      const ok = allowed[from].includes(to);
      expect(canTransitionCard(from, to)).toBe(ok);
      if (ok) expect(() => assertCardTransition(from, to)).not.toThrow();
      else expect(() => assertCardTransition(from, to)).toThrow('Illegal card transition');
    },
  );
});

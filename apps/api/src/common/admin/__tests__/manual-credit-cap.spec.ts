import { tashkentDayStart } from '@repo/shared';
import type { Db } from '../../../infra/prisma/db';
import { AppError } from '../../exceptions/app-error';
import {
  MANUAL_CREDIT_CAP_REASON,
  checkManualCreditCap,
  withinManualCreditCap,
  type ManualCreditLedger,
} from '../manual-credit-cap';

// The daily cap of money created by hand (D-63 (5)): the boundary, the Tashkent day and the
// lock order are the money rules; the SQL sum itself is proven in the admin write e2e.
const NOW = new Date('2026-11-17T20:30:00.000Z'); // 01:30 on Nov 18 in Tashkent
const CAP = 500_000_000n;
const tx = {} as Db;

function ledger(used: bigint) {
  const calls: string[] = [];
  const fake: ManualCreditLedger & { calls: string[]; since: Date[] } = {
    calls,
    since: [],
    lockManualCredits: () => {
      calls.push('lock');
      return Promise.resolve();
    },
    manualCreditTotalSince: (_tx, since) => {
      calls.push('sum');
      fake.since.push(since);
      return Promise.resolve(used);
    },
  };
  return fake;
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return error instanceof AppError ? error.details : error;
}

describe('withinManualCreditCap', () => {
  it('exactly the cap passes; one tiyin over it does not', () => {
    expect(withinManualCreditCap(0n, CAP, CAP)).toBe(true);
    expect(withinManualCreditCap(CAP - 1n, 1n, CAP)).toBe(true);
    expect(withinManualCreditCap(CAP, 1n, CAP)).toBe(false);
    expect(withinManualCreditCap(0n, CAP + 1n, CAP)).toBe(false);
  });
});

describe('checkManualCreditCap', () => {
  it('sums from the start of the Tashkent day, after taking the cap lock', async () => {
    const fake = ledger(0n);
    await checkManualCreditCap(fake, tx, { amountTiyin: 1n, capTiyin: CAP, now: NOW });
    expect(fake.calls).toEqual(['lock', 'sum']);
    expect(fake.since).toEqual([tashkentDayStart(NOW)]);
    expect(fake.since[0]?.toISOString()).toBe('2026-11-17T19:00:00.000Z');
  });

  it('refuses the tiyin over the cap with its own reason; the cap itself passes', async () => {
    await expect(
      checkManualCreditCap(ledger(CAP - 100n), tx, { amountTiyin: 100n, capTiyin: CAP, now: NOW }),
    ).resolves.toBeUndefined();
    expect(
      await refusal(
        checkManualCreditCap(ledger(CAP - 100n), tx, {
          amountTiyin: 101n,
          capTiyin: CAP,
          now: NOW,
        }),
      ),
    ).toEqual({ field: 'amountTiyin', reason: MANUAL_CREDIT_CAP_REASON });
  });

  it('a debit (or nothing) never counts and takes no lock', async () => {
    const fake = ledger(CAP * 10n);
    await checkManualCreditCap(fake, tx, { amountTiyin: -5n, capTiyin: CAP, now: NOW });
    await checkManualCreditCap(fake, tx, { amountTiyin: 0n, capTiyin: CAP, now: NOW });
    expect(fake.calls).toEqual([]);
  });
});

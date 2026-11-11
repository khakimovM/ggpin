import { TopupIntentCreatedSchema } from '@repo/shared';
import { BASE_TIYIN, HOUR, usePaymentsE2e } from './payments-e2e.helpers';

// Three suffixes per base (1..3 so‘m) so that a card runs out of amounts in a few requests.
const e2e = usePaymentsE2e({ env: { TOPUP_SUFFIX_MAX_SOM: '3' } });
const amount = (suffixSom: number): string => String(BASE_TIYIN + BigInt(suffixSom) * 100n);

// A new user asks for the base amount; the answer is the status and, on 201, the pay amount.
async function payAmountOf(): Promise<{ status: number; amount?: string }> {
  const res = await e2e.create(await e2e.newUser());
  if (res.status !== 201) return { status: res.status };
  return { status: 201, amount: TopupIntentCreatedSchema.parse(res.body.data).payAmountTiyin };
}

describe('unique amounts and the grace window (docs/05 §3)', () => {
  it('an amount still reserved by an EXPIRED (in grace) or CANCELLED request is never reissued', async () => {
    const card = await e2e.card();
    const other = await e2e.newUser();
    const createdAt = new Date(Date.now() - 2 * HOUR);
    for (const [suffixSom, status] of [
      [1, 'EXPIRED'],
      [2, 'CANCELLED'],
    ] as const) {
      await e2e.fixtureIntent(other.id, {
        cardId: card.id,
        baseTiyin: BASE_TIYIN,
        suffixSom,
        status,
        createdAt,
        reservedUntil: new Date(Date.now() + 22 * HOUR),
      });
    }
    expect(await payAmountOf()).toEqual({ status: 201, amount: amount(3) });
    // Every amount of the only card is held now: 503, never a shared amount.
    expect(await payAmountOf()).toEqual({ status: 503 });
  });

  it('a PAID amount stays reserved too (a repeat payment must not land in another wallet)', async () => {
    const card = await e2e.card();
    const other = await e2e.newUser({ ageDays: 30 });
    const createdAt = new Date(Date.now() - 2 * HOUR);
    for (const suffixSom of [1, 2, 3]) {
      await e2e.fixtureIntent(other.id, {
        cardId: card.id,
        baseTiyin: BASE_TIYIN,
        suffixSom,
        status: 'PAID',
        createdAt,
        paidAt: new Date(createdAt.getTime() + 60_000),
        reservedUntil: new Date(Date.now() + 22 * HOUR),
      });
    }
    expect(await payAmountOf()).toEqual({ status: 503 });
  });

  it('an amount whose reservation ended is free again', async () => {
    const card = await e2e.card();
    const other = await e2e.newUser();
    const createdAt = new Date(Date.now() - 30 * HOUR);
    for (const suffixSom of [1, 3]) {
      await e2e.fixtureIntent(other.id, {
        cardId: card.id,
        baseTiyin: BASE_TIYIN,
        suffixSom,
        status: 'EXPIRED',
        createdAt,
        reservedUntil: new Date(Date.now() + (suffixSom === 1 ? -HOUR : 5 * HOUR)),
      });
    }
    // 2 is fresh, 1 ended an hour ago, 3 is held: fresh first, then the ended one, then none.
    expect(await payAmountOf()).toEqual({ status: 201, amount: amount(2) });
    expect(await payAmountOf()).toEqual({ status: 201, amount: amount(1) });
    expect(await payAmountOf()).toEqual({ status: 503 });
  });

  it('a card out of amounts is skipped for the next card (each in its own lock)', async () => {
    const full = await e2e.card({ limitTiyin: 900_000_000_000_000n });
    const next = await e2e.card({ limitTiyin: 10_000_000_000n });
    const other = await e2e.newUser();
    const createdAt = new Date(Date.now() - HOUR);
    for (const suffixSom of [1, 2, 3]) {
      await e2e.fixtureIntent(other.id, {
        cardId: full.id,
        baseTiyin: BASE_TIYIN,
        suffixSom,
        status: 'CANCELLED',
        createdAt,
        reservedUntil: new Date(Date.now() + HOUR),
      });
    }
    const res = await e2e.create(await e2e.newUser());
    expect(TopupIntentCreatedSchema.parse(res.body.data).card?.number).toBe(next.pan);
  });

  it('parallel requests on a card with 3 amounts: exactly 3 succeed with 3 different amounts, the rest 503', async () => {
    await e2e.card();
    const users = await Promise.all(Array.from({ length: 6 }, () => e2e.newUser()));
    const results = await Promise.all(users.map((user) => e2e.create(user)));
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(3);
    expect(results.filter((r) => r.status === 503)).toHaveLength(3);
    const amounts = ok.map((r) => TopupIntentCreatedSchema.parse(r.body.data).payAmountTiyin);
    expect(amounts.sort()).toEqual([amount(1), amount(2), amount(3)]);
  }, 60_000);
});

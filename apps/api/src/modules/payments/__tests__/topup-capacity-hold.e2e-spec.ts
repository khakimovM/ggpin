import { TopupIntentCreatedSchema } from '@repo/shared';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { BASE_TIYIN, HOUR, MINUTE, usePaymentsE2e } from './payments-e2e.helpers';

// D-42 (1): an unpaid CANCELLED/EXPIRED request counts against its card's limit only until
// LEAST(reservedUntil, expiresAt + TOPUP_CAPACITY_HOLD_SEC), while its AMOUNT stays reserved for
// the whole grace. expiresAt is immutable (DB guard), so the test moves the API's clock instead
// of the row: a 60 s hold and two suffixes keep the numbers small.
const HOLD_SEC = 60;
let offsetMs = 0;
const clock: Clock = { now: () => new Date(Date.now() + offsetMs) };
const e2e = usePaymentsE2e({
  env: { TOPUP_SUFFIX_MAX_SOM: '2', TOPUP_CAPACITY_HOLD_SEC: String(HOLD_SEC) },
  overrides: [{ provide: CLOCK, useValue: clock }],
});

afterEach(() => {
  offsetMs = 0;
});

describe('capacity hold of a cancelled request (D-42 (1))', () => {
  it('create -> cancel: the card is short inside the window, has room after it, and the cancelled amount is still not reissued', async () => {
    // Room for exactly one request (base + the largest suffix) plus one base amount: with the
    // cancelled amount still counted, a second request no longer fits.
    const need = BASE_TIYIN + 2n * 100n;
    await e2e.card({ limitTiyin: need + BASE_TIYIN });

    const first = await e2e.newUser();
    const created = await e2e.create(first);
    expect(created.status).toBe(201);
    const { intentId, payAmountTiyin: cancelledAmount } = TopupIntentCreatedSchema.parse(
      created.body.data,
    );
    expect((await e2e.post(`/payments/intents/${intentId}/cancel`, first)).status).toBe(200);

    const second = await e2e.newUser();
    expect((await e2e.create(second)).status).toBe(503);

    // Past expiresAt + hold (the request lived 30 min): the capacity is back.
    offsetMs = 30 * MINUTE + (HOLD_SEC + 5) * 1000;
    await e2e.heartbeat(-offsetMs); // the listener is alive on the moved clock too
    const later = await e2e.create(second);
    expect(later.status).toBe(201);
    const reissued = TopupIntentCreatedSchema.parse(later.body.data).payAmountTiyin;
    // The amount itself is reserved for the whole grace: the other suffix is given.
    expect(reissued).not.toBe(cancelledAmount);
    const row = await e2e.db().paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(row.reservedUntil?.getTime()).toBeGreaterThan(Date.now() + offsetMs);
  });

  it('an overdue PENDING the sweep has not expired: no longer counted after expiresAt + hold, its amount still not reissued (R-1)', async () => {
    const need = BASE_TIYIN + 2n * 100n;
    const card = await e2e.card({ limitTiyin: need + BASE_TIYIN });
    const other = await e2e.newUser();
    const stale = await e2e.fixtureIntent(other.id, {
      cardId: card.id,
      baseTiyin: BASE_TIYIN,
      suffixSom: 1,
      status: 'PENDING',
      createdAt: new Date(Date.now() - 2 * HOUR - 30 * MINUTE),
      expiresAt: new Date(Date.now() - 2 * HOUR),
      reservedUntil: new Date(Date.now() + 22 * HOUR),
    });
    const res = await e2e.create(await e2e.newUser());
    expect(res.status).toBe(201);
    // Suffix 1 is still reserved (reservedUntil > now): the request gets suffix 2.
    expect(TopupIntentCreatedSchema.parse(res.body.data).payAmountTiyin).toBe(String(need));
    const row = await e2e.db().paymentIntent.findUniqueOrThrow({ where: { id: stale } });
    expect(row.status).toBe('PENDING'); // nobody swept it: the predicate alone released the room
  });

  it('a live PENDING request counts fully', async () => {
    const need = BASE_TIYIN + 2n * 100n;
    await e2e.card({ limitTiyin: need + BASE_TIYIN });
    expect((await e2e.create(await e2e.newUser())).status).toBe(201);
    expect((await e2e.create(await e2e.newUser())).status).toBe(503);
  });
});

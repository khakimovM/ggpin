import {
  HeldPayoutError,
  assertHeldPayoutClean,
  heldPayoutOf,
  type HeldPayoutDb,
} from '../held-payout';

// S9f M-1 / L-1, held part: the payout rows of a HELD order, judged (the e2e proves the queries).

type Responses = readonly unknown[];
type Statuses = readonly string[];

function dbOf(responses: Responses, statuses: Statuses): HeldPayoutDb {
  const fake = {
    fulfillmentAttempt: {
      findMany: () => Promise.resolve(responses.map((response) => ({ response }))),
    },
    tonTransfer: { findMany: () => Promise.resolve(statuses.map((status) => ({ status }))) },
  };
  return fake as unknown as HeldPayoutDb;
}

const LATE = { ton: { late: { from: 'EXPIRED', outcome: 'SEQNO_HELD' } } };
const DESTINATION = { ton: { lateDestination: { verdict: 'DESTINATION_ABORTED' } } };

describe('heldPayoutOf', () => {
  it('clean: no rows, or EXPIRED transfers with no late fact', async () => {
    await expect(heldPayoutOf(dbOf([], []), 'o')).resolves.toBe('clean');
    const expired = dbOf([{ ton: { suspect: {} } }, null], ['EXPIRED', 'EXPIRED']);
    await expect(heldPayoutOf(expired, 'o')).resolves.toBe('clean');
  });

  it('lateFact: `late` or `lateDestination` on any attempt, before a live transfer', async () => {
    await expect(heldPayoutOf(dbOf([null, LATE], ['EXPIRED']), 'o')).resolves.toBe('lateFact');
    const live = dbOf([DESTINATION], ['CONFIRMED']);
    await expect(heldPayoutOf(live, 'o')).resolves.toBe('lateFact');
  });

  it('liveTransfer: any transfer that is not EXPIRED', async () => {
    for (const status of ['SIGNED', 'BROADCAST', 'CONFIRMED', 'CONSUMED_UNMATCHED', 'BOUNCED']) {
      const db = dbOf([null], ['EXPIRED', status]);
      await expect(heldPayoutOf(db, 'o')).resolves.toBe('liveTransfer');
    }
  });

  it('assertHeldPayoutClean throws HeldPayoutError with the reason, passes when clean', async () => {
    await expect(assertHeldPayoutClean(dbOf([], ['EXPIRED']), 'o')).resolves.toBeUndefined();
    const refused = assertHeldPayoutClean(dbOf([LATE], ['EXPIRED']), 'o');
    await expect(refused).rejects.toBeInstanceOf(HeldPayoutError);
    await expect(assertHeldPayoutClean(dbOf([], ['SIGNED']), 'o')).rejects.toMatchObject({
      orderId: 'o',
      why: 'liveTransfer',
    });
  });
});

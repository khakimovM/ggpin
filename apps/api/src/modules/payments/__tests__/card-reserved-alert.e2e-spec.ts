import { cardReservedHighRef, notifyJobId, notifyJobSchema } from '@repo/shared';
import { BASE_TIYIN, createBody, usePaymentsE2e } from './payments-e2e.helpers';

// D-42 (1): after a request is created, an owner alert when unpaid reservations hold more than
// half of what the card may still receive; one job per card per clock hour (the job id carries
// the hour, BullMQ drops the repeat). No notify consumer runs in the API e2e, so the jobs stay
// in the queue where the test can read them; the helper removes them after the file.
const e2e = usePaymentsE2e();

/** Every cardReservedHigh job of the card, whatever the hour. */
async function alertJobsOf(cardId: string): Promise<string[]> {
  const jobs = await e2e.notifyQueue().getJobs(['waiting', 'delayed', 'completed', 'failed']);
  return jobs.flatMap((job) => {
    const data = notifyJobSchema.safeParse(job.data);
    if (!data.success || data.data.kind !== 'OWNER_ALERT') return [];
    const { alert, refId } = data.data;
    return alert === 'cardReservedHigh' && refId.startsWith(`${cardId}_`) ? [job.id ?? ''] : [];
  });
}

const jobIdAt = (cardId: string, at: Date): string =>
  notifyJobId({
    kind: 'OWNER_ALERT',
    alert: 'cardReservedHigh',
    refId: cardReservedHighRef(cardId, at),
  });

describe('cardReservedHigh (D-42 (1))', () => {
  it('over 50% reserved: one job with the hourly id; a second request in the same hour adds none', async () => {
    // 30 000 so'm limit: a 20 000 so'm request (+ suffix) holds over half of it.
    const card = await e2e.card({ limitTiyin: 3_000_000n });
    const before = new Date();
    expect((await e2e.create(await e2e.newUser())).status).toBe(201);
    const after = new Date();
    const jobs = await alertJobsOf(card.id);
    expect(jobs).toHaveLength(1);
    // The id is the one of this card and this hour (the hour may roll over during the request).
    expect([jobIdAt(card.id, before), jobIdAt(card.id, after)]).toContain(jobs[0]);
    const job = await e2e.notifyQueue().getJob(jobs[0] ?? '');
    // Ids only: the card and the hour bucket, never an amount, a PAN or a user.
    const data = notifyJobSchema.parse(job?.data);
    expect(Object.keys(data).sort()).toEqual(['alert', 'kind', 'refId']);
    expect(data).toMatchObject({ kind: 'OWNER_ALERT', alert: 'cardReservedHigh' });
    expect(data.refId).toMatch(new RegExp(`^${card.id}_\\d+$`));

    // Still over half after a smaller second request (5 000 so'm still fits): no second job.
    const second = await e2e.create(await e2e.newUser(), createBody(500_000n));
    expect(second.status).toBe(201);
    expect(await alertJobsOf(card.id)).toEqual(jobs);
  });

  it('at or under 50% reserved: no job', async () => {
    // 100 000 so'm limit: one 20 000 so'm request is about 20%.
    const card = await e2e.card({ limitTiyin: 5n * BASE_TIYIN });
    expect((await e2e.create(await e2e.newUser())).status).toBe(201);
    expect(await alertJobsOf(card.id)).toEqual([]);
  });
});

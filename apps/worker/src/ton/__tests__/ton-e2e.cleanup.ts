import type { PrismaClient } from '@repo/db';
import type { Queue } from 'bullmq';
import { refIdsOf } from './ton-e2e.fixtures';

/** What one e2e file created: its orders, wallets and the notify job ids its checks named. */
export interface RunRefs {
  readonly orderIds: ReadonlySet<string>;
  readonly walletAddresses: ReadonlySet<string>;
  readonly jobIds: ReadonlySet<string>;
}

/**
 * Removes the notify jobs of one e2e run (refId = one of its orders, transfers or snapshots, or a
 * job id a check named). The caller closes the queue and the client in a `finally` (S9i).
 */
export async function removeRunJobs(db: PrismaClient, notify: Queue, run: RunRefs): Promise<void> {
  const addresses = [...run.walletAddresses];
  const [transfers, snapshots] = await Promise.all([
    db.tonTransfer.findMany({ where: { walletAddress: { in: addresses } }, select: { id: true } }),
    db.walletSnapshot.findMany({ where: { address: { in: addresses } }, select: { id: true } }),
  ]);
  const refs = new Set([
    ...run.orderIds,
    ...transfers.map((r) => r.id),
    ...snapshots.map((r) => r.id),
  ]);
  const jobs = await notify.getJobs([
    'waiting',
    'delayed',
    'paused',
    'prioritized',
    'completed',
    'failed',
  ]);
  for (const job of jobs) {
    const mine =
      refIdsOf(job.data).some((ref) => refs.has(ref)) ||
      (job.id !== undefined && run.jobIds.has(job.id));
    if (mine) await job.remove();
  }
}

import { Injectable, Logger } from '@nestjs/common';
import {
  ORDER_LOCK_STUCK_AFTER_MS,
  RECONCILE_BATCH_LIMIT,
  describeErrorForLog,
} from '@repo/shared';
import { episodeRef } from './guard-ref';
import { OrderLockKeys, type LeaseHolder } from './order-lock-keys';
import { OrderSweepsRepository } from './order-sweeps.repository';
import { ReconcileNotifier } from './reconcile-notifier';
import {
  StepTally,
  type ReconcileContext,
  type ReconcileStep,
  type StepReport,
} from './reconcile-step';

// A poisoned order lease (phase 5 S9d, D-64 (3), Q-17, plan item 27; fix round F1/F4): the SAME
// holder (the lease's token, read with GET) has kept `lock:order:{id}` for at least
// ORDER_LOCK_STUCK_AFTER_MS, proven by two ticks of this process, and the order (PAID, QUEUED,
// PROCESSING, HELD or NEEDS_REVIEW) has not changed for as long. Whatever its fulfill-order job
// does (a job that keeps meeting BUSY may still look alive), no run can take the order: the owner
// gets the `needsReview` alert, refId `<orderId>_lock_<hour of the tick's database clock>`:
// - the hour is the episode (plan §12): a lease stuck for long is heard again every hour, never
//   more often; the plain order id stays free for the real NEEDS_REVIEW alert (notify ids dedupe
//   for 30 days, a shared id would swallow it); the API reads the order back with refIdSubject
//   (guard-ref.ts, scope `lock`);
// - one look is never enough: another replica's short reconcile lease or a run that just started
//   has a token of its own and is gone (or another) by the next look; a live run renews its token
//   for minutes, a TON wait included, never for half an hour;
// - the memory of what was seen is this process's (restart: empty, the alert comes later, never
//   wrongly), at most MAX_TRACKED leases; what a full SCAN cycle no longer returns is forgotten;
// - a key holding no token (another type, or empty: UNNAMED) no OrderLock wrote: logged once,
//   counted on its own, and alerted like a lease whose holder never changes;
// - the key is NEVER deleted or touched (order-lock-keys.ts): its holder may be alive;
// - this step takes no lease itself (the lease is the very thing that is stuck).

/** Leases remembered at most; a new one past this is counted `untracked` (seen next cycle). */
export const MAX_TRACKED = 10_000;
/** What an UNNAMED lease is remembered as: no OrderLock token is ever this. */
const UNNAMED = '\u0000unnamed';

interface Seen {
  readonly token: string;
  /** When this holder was first seen (the tick's clock). */
  readonly sinceMs: number;
  cycle: number;
}

@Injectable()
export class OrderLockStuckStep implements ReconcileStep {
  readonly name = 'lockStuck';
  private readonly logger = new Logger(OrderLockStuckStep.name);
  private readonly seen = new Map<string, Seen>();
  private readonly loggedOnce = new Set<string>();
  private cycle = 0;

  constructor(
    private readonly keys: OrderLockKeys,
    private readonly repository: OrderSweepsRepository,
    private readonly notifier: ReconcileNotifier,
  ) {}

  async run(context: ReconcileContext): Promise<StepReport> {
    const tally = new StepTally(this.name);
    const batch = await this.keys.next(RECONCILE_BATCH_LIMIT);
    for (let i = 0; i < batch.malformed; i += 1) tally.add('malformedKey');
    for (let i = 0; i < batch.overflow; i += 1) tally.add('keyOverflow');
    const before = new Date(context.nowMs - ORDER_LOCK_STUCK_AFTER_MS);
    const unchanged = new Set(await this.repository.openUnchanged(batch.orderIds, before));
    for (const orderId of batch.orderIds) {
      try {
        const outcome = await this.check(orderId, unchanged.has(orderId), context.nowMs);
        if (outcome !== null) tally.add(...outcome);
      } catch (error) {
        tally.add('failed');
        this.logger.error(
          `order ${orderId}: lock check failed: ${describeErrorForLog(error, 200)}`,
        );
      }
    }
    if (batch.wrapped) this.endCycle();
    return tally.report();
  }

  private async check(
    orderId: string,
    unchanged: boolean,
    nowMs: number,
  ): Promise<[string, string?] | null> {
    const holder = await this.keys.holder(orderId);
    if (holder.kind === 'gone') {
      this.forget(orderId);
      return unchanged ? ['released'] : null;
    }
    if (holder.kind === 'unnamed') {
      this.once(`unnamed:${orderId}`, () =>
        this.logger.error(`order ${orderId}: its lock key holds no lease token (UNNAMED)`),
      );
    }
    const since = this.observe(orderId, holder, nowMs);
    if (since === null) return ['untracked'];
    if (!unchanged) return null;
    if (nowMs - since < ORDER_LOCK_STUCK_AFTER_MS) {
      return [holder.kind === 'unnamed' ? 'unnamedWatching' : 'watching'];
    }
    return this.alert(orderId, holder, nowMs);
  }

  /** When this holder of the lease was first seen; null when it cannot be remembered (full). */
  private observe(orderId: string, holder: LeaseHolder, nowMs: number): number | null {
    const token = holder.kind === 'token' ? holder.token : UNNAMED;
    const known = this.seen.get(orderId);
    if (known?.token === token) {
      known.cycle = this.cycle;
      return known.sinceMs;
    }
    if (known === undefined && this.seen.size >= MAX_TRACKED) return null;
    this.seen.set(orderId, { token, sinceMs: nowMs, cycle: this.cycle });
    return nowMs;
  }

  private async alert(
    orderId: string,
    holder: LeaseHolder,
    nowMs: number,
  ): Promise<[string, string?]> {
    const ref = episodeRef(orderId, 'lock', nowMs);
    if (ref === null) {
      this.once(`ref:${orderId}`, () =>
        this.logger.error(`order ${orderId}: a stuck order lock, but no valid alert id: not sent`),
      );
      return ['invalidRef'];
    }
    this.logger.warn(`order ${orderId}: the same holder has kept its order lock for too long`);
    const sent = await this.notifier.alert('needsReview', ref);
    if (!sent) return ['alertLost'];
    return [holder.kind === 'unnamed' ? 'unnamedAlerted' : 'alerted', orderId];
  }

  private forget(orderId: string): void {
    this.seen.delete(orderId);
    this.loggedOnce.delete(`unnamed:${orderId}`);
    this.loggedOnce.delete(`ref:${orderId}`);
  }

  /** A full SCAN cycle ended: a lease it did not return no longer exists. */
  private endCycle(): void {
    for (const [orderId, entry] of this.seen) {
      if (entry.cycle !== this.cycle) this.forget(orderId);
    }
    this.cycle += 1;
  }

  private once(key: string, log: () => void): void {
    if (this.loggedOnce.has(key)) return;
    if (this.loggedOnce.size < MAX_TRACKED) this.loggedOnce.add(key);
    log();
  }
}

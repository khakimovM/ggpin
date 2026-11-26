import { transitionOrder, type Prisma, type PrismaClient } from '@repo/db';
import { OrderRetryAuditSchema } from '@repo/shared';
import type { TonPayRequest, TonPayResult } from '../../ton/ton-payout';
import type { TonPayer } from '../fulfill-tokens';

// Releases of a HELD order as their writers make them (phase 5 S9b). `release` mirrors the API's
// order-retry.service.ts transaction (the worker never imports the API): the order row locked,
// HELD re-checked, the ORDER_RETRY audit row with `before.maxAttemptNo` read under the lock, then
// HELD -> QUEUED through the state machine. An order no longer HELD writes nothing (applied:false).
// Like the API, a CLI or ADMIN row is parsed with the shared OrderRetryAuditSchema before it is
// written; only a test that forges a row on purpose (`raw`) or a SYSTEM row skips it.

export type ReleaseActor =
  | { readonly kind: 'CLI' }
  /** `type`: `after.actor.type` (default ADMIN; another value makes a mixed row). */
  | { readonly kind: 'ADMIN'; readonly role: string; readonly type?: string }
  | { readonly kind: 'SYSTEM' };

export interface ReleaseOptions {
  /** Replaces the `before` the writer would store (a corrupt or forged row; needs `raw`). */
  readonly before?: Prisma.InputJsonValue;
  /** Writes the row without the shared schema: a row no writer of ours would produce. */
  readonly raw?: boolean;
}

function auditActor(actor: ReleaseActor): { actorType: string; after: Prisma.InputJsonObject } {
  switch (actor.kind) {
    case 'CLI':
      return {
        actorType: 'CLI',
        after: { status: 'QUEUED', operator: 'aziz', actor: { type: 'CLI', role: 'OWNER' } },
      };
    case 'ADMIN':
      return {
        actorType: 'ADMIN',
        after: { status: 'QUEUED', actor: { type: actor.type ?? 'ADMIN', role: actor.role } },
      };
    case 'SYSTEM':
      return { actorType: 'SYSTEM', after: { status: 'QUEUED' } };
  }
}

/** True when this call released the order (false: it was not HELD any more). */
export async function release(
  db: PrismaClient,
  orderId: string,
  actor: ReleaseActor,
  options: ReleaseOptions = {},
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status !== 'HELD') return false;
    const top = await tx.fulfillmentAttempt.aggregate({
      where: { orderId },
      _max: { attemptNo: true },
    });
    const { actorType, after } = auditActor(actor);
    const before = options.before ?? { status: 'HELD', maxAttemptNo: top._max.attemptNo ?? 0 };
    if (options.raw !== true && actor.kind !== 'SYSTEM')
      OrderRetryAuditSchema.parse({ before, after });
    const audit = await tx.auditLog.create({
      data: {
        actorType,
        actorId: actor.kind === 'ADMIN' ? 'admin-user-1' : null,
        action: 'ORDER_RETRY',
        targetType: 'Order',
        targetId: orderId,
        before,
        after,
        reason: 'checked the wallet history',
      },
      select: { id: true },
    });
    const note = `operator retry ${audit.id}`;
    const base = { orderId, from: 'HELD', to: 'QUEUED', note } as const;
    await transitionOrder(
      tx,
      actor.kind === 'SYSTEM'
        ? { ...base, actor: 'system' }
        : { ...base, actor: 'admin', actorRef: 'aziz' },
    );
    return true;
  });
}

/** A stand-in for the TON module's pay(): each call answers with the next scripted result. */
export class ScriptedPayer implements TonPayer {
  readonly calls: TonPayRequest[] = [];

  constructor(
    private readonly answer: (request: TonPayRequest, call: number) => Promise<TonPayResult>,
  ) {}

  pay(request: TonPayRequest): Promise<TonPayResult> {
    this.calls.push(request);
    return this.answer(request, this.calls.length);
  }
}

/** What the TON module does on EXPIRED: the attempt FAILED (TON_EXPIRED), the order PROCESSING. */
export async function expire(db: PrismaClient, request: TonPayRequest): Promise<TonPayResult> {
  await db.fulfillmentAttempt.update({
    where: { id: request.attemptId },
    data: { status: 'FAILED', error: 'TON_EXPIRED' },
  });
  return { status: 'EXPIRED', transferId: 'none' };
}

import { Injectable } from '@nestjs/common';
import {
  resolveNeedsReview,
  transitionOrder,
  type Prisma,
  type ResolveNeedsReviewInput,
  type ResolveNeedsReviewResult,
} from '@repo/db';
import type { NumberedAttemptRow, OrderStatus } from '@repo/shared';
import type { Db } from '../../../infra/prisma/db';
import { PrismaService } from '../../../infra/prisma/prisma.service';

// All Prisma access of the owner CLI's order commands (phase 5 S10). The recipient, the provider
// handle, the quote's cost and the idempotency key are NEVER selected: what the CLI cannot read it
// cannot print (brief: no recipient username, displayName or providerRef in any output).

export const REVIEW_RESOLVE_ACTION = 'ORDER_REVIEW_RESOLVE';
export const ORDER_RETRY_ACTION = 'ORDER_RETRY';

/** A transfer of these states never left the wallet (docs/06 Z3). */
const NOT_SENT_TRANSFER = ['EXPIRED', 'ONCHAIN_FAILED'] as const;

const LIST_ROW = {
  id: true,
  number: true,
  status: true,
  statusReason: true,
  priceTiyin: true,
  discountTiyin: true,
  quantity: true,
  createdAt: true,
  product: { select: { slug: true } },
} satisfies Prisma.OrderSelect;

const TRANSFER = {
  id: true,
  status: true,
  seqno: true,
  validUntil: true,
  walletAddress: true,
  toAddress: true,
  amountNanoTon: true,
  extMsgHash: true,
  txHash: true,
  txLt: true,
  confirmedAt: true,
} satisfies Prisma.TonTransferSelect;

const DETAIL = {
  ...LIST_ROW,
  userId: true,
  costCurrency: true,
  deliveredAt: true,
  updatedAt: true,
  product: { select: { slug: true, deliveryType: true } },
  events: {
    select: { from: true, to: true, actor: true, note: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  attempts: {
    select: {
      id: true,
      attemptNo: true,
      adapter: true,
      status: true,
      externalRef: true,
      error: true,
      response: true,
      createdAt: true,
      tonTransfer: { select: TRANSFER },
    },
    orderBy: { attemptNo: 'asc' },
  },
} satisfies Prisma.OrderSelect;

export type OrderListRow = Prisma.OrderGetPayload<{ select: typeof LIST_ROW }>;
export type OrderDetailRow = Prisma.OrderGetPayload<{ select: typeof DETAIL }>;
export type OrderAttemptRow = OrderDetailRow['attempts'][number];

export interface LedgerRow {
  readonly id: string;
  readonly kind: string;
  readonly amountTiyin: bigint;
  readonly createdAt: Date;
}

export interface AuditRow {
  readonly id: string;
  readonly action: string;
  readonly reason: string | null;
  readonly createdAt: Date;
}

/** How an order left NEEDS_REVIEW, read back for a re-run (idempotent replay). */
export interface Resolution {
  readonly auditId: string;
  /** When the resolution was written: its effects are queued again only inside the dedupe window. */
  readonly auditAt: Date;
  readonly to: OrderStatus | null;
  readonly proofKind: string | null;
  /** The transfer of a stored TON_UNMATCHED_RESOLVED / SENT_ELSEWHERE proof (its security alert). */
  readonly compromisedTransferId: string | null;
}

export interface AuditInput {
  readonly action: string;
  readonly targetId: string;
  readonly before: Prisma.InputJsonObject;
  readonly after: Prisma.InputJsonObject;
  readonly reason: string;
  readonly ip: string | null;
}

@Injectable()
export class OrderAdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(fn);
  }

  list(status: OrderStatus | undefined, limit: number): Promise<OrderListRow[]> {
    return this.prisma.client.order.findMany({
      where: status === undefined ? {} : { status },
      select: LIST_ROW,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  async detail(orderId: string, db: Db = this.prisma.client): Promise<OrderDetailRow | null> {
    const order = await db.order.findUnique({ where: { id: orderId }, select: DETAIL });
    if (order === null) return null;
    // Only the TON module's part of an attempt's response is carried (audit I-2): an adapter's raw
    // answer may name the recipient, and what the CLI does not hold it cannot print.
    return {
      ...order,
      attempts: order.attempts.map((a) => ({ ...a, response: tonPartOf(a.response) })),
    };
  }

  ledger(orderId: string): Promise<LedgerRow[]> {
    return this.prisma.client.ledgerEntry.findMany({
      where: { refType: 'ORDER', refId: orderId },
      select: { id: true, kind: true, amountTiyin: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  audits(orderId: string): Promise<AuditRow[]> {
    return this.prisma.client.auditLog.findMany({
      where: { targetType: 'Order', targetId: orderId },
      select: { id: true, action: true, reason: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * `resolveNeedsReview` in the caller's transaction, then the id of the audit row it wrote: an
   * order leaves NEEDS_REVIEW at most once (its exits lead only to REFUNDED), so there is one.
   */
  async resolve(
    tx: Db,
    input: ResolveNeedsReviewInput,
  ): Promise<{ readonly result: ResolveNeedsReviewResult; readonly auditId: string }> {
    const result = await resolveNeedsReview(tx, input);
    const audit = await tx.auditLog.findFirstOrThrow({
      where: { action: REVIEW_RESOLVE_ACTION, targetType: 'Order', targetId: input.orderId },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    return { result, auditId: audit.id };
  }

  /**
   * How many of these (just closed) attempts have a TON transfer of their own that never left the
   * wallet (EXPIRED, or ONCHAIN_FAILED: executed, nothing sent). docs/06 Z3, I-8.
   */
  notSentTransfers(tx: Db, attemptIds: readonly string[]): Promise<number> {
    return tx.tonTransfer.count({
      where: { attemptId: { in: [...attemptIds] }, status: { in: [...NOT_SENT_TRANSFER] } },
    });
  }

  /** `attemptNo` and `error` of every attempt of the order (the attempt cap), read in `tx`. */
  attemptErrors(tx: Db, orderId: string): Promise<NumberedAttemptRow[]> {
    return tx.fulfillmentAttempt.findMany({
      where: { orderId },
      select: { attemptNo: true, error: true },
    });
  }

  async resolution(orderId: string): Promise<Resolution | null> {
    const audit = await this.prisma.client.auditLog.findFirst({
      where: { action: REVIEW_RESOLVE_ACTION, targetType: 'Order', targetId: orderId },
      select: { id: true, after: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    if (audit === null) return null;
    const left = await this.prisma.client.orderEvent.findFirst({
      where: { orderId, from: 'NEEDS_REVIEW' },
      select: { to: true },
      orderBy: { createdAt: 'asc' },
    });
    const proof = storedProof(audit.after);
    return {
      auditId: audit.id,
      auditAt: audit.createdAt,
      to: left?.to ?? null,
      proofKind: textOf(proof, 'kind'),
      compromisedTransferId:
        textOf(proof, 'kind') === 'TON_UNMATCHED_RESOLVED' &&
        textOf(proof, 'finding') === 'SENT_ELSEWHERE'
          ? textOf(proof, 'transferId')
          : null,
    };
  }

  /** Locks the order row (`FOR UPDATE`) and reads its status under the lock. */
  async lockOrder(
    tx: Db,
    orderId: string,
  ): Promise<{ readonly status: OrderStatus; readonly statusReason: string | null } | null> {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    return tx.order.findUnique({
      where: { id: orderId },
      select: { status: true, statusReason: true },
    });
  }

  /** The note of the order's latest event (the HELD event when the order is HELD). */
  async lastEvent(
    orderId: string,
    db: Db = this.prisma.client,
  ): Promise<{
    readonly from: OrderStatus | null;
    readonly to: OrderStatus;
    readonly actor: string;
    readonly note: string | null;
  } | null> {
    return db.orderEvent.findFirst({
      where: { orderId },
      select: { from: true, to: true, actor: true, note: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** HELD -> QUEUED by the operator, through the state machine (`transitionOrder`, CAS). */
  release(tx: Db, orderId: string, operator: string, note: string): Promise<{ eventId: string }> {
    return transitionOrder(tx, {
      orderId,
      from: 'HELD',
      to: 'QUEUED',
      actor: 'admin',
      actorRef: operator,
      note,
    });
  }

  /** The CLI's audit row: `actorType CLI`, no actor id, the operator in `after` (D-46). */
  createAudit(tx: Db, data: AuditInput): Promise<{ id: string }> {
    return tx.auditLog.create({
      data: { actorType: 'CLI', actorId: null, targetType: 'Order', ...data },
      select: { id: true },
    });
  }
}

type JsonObject = { readonly [key: string]: Prisma.JsonValue };

function tonPartOf(response: Prisma.JsonValue | null): Prisma.JsonValue | null {
  const ton = asObject(response)?.['ton'];
  return ton === undefined ? null : { ton };
}

function asObject(value: Prisma.JsonValue | null | undefined): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function storedProof(after: Prisma.JsonValue | null): JsonObject | null {
  return asObject(asObject(after)?.['proof']);
}

function textOf(object: JsonObject | null, key: string): string | null {
  const value = object?.[key];
  return typeof value === 'string' ? value : null;
}

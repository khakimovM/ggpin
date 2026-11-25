import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, TonTransferStatus, Tx } from '@repo/db';
import type { OrderStatus } from '@repo/shared';
import { PrismaService } from '../infra/prisma/prisma.service';
import { isDeadlock } from './ton-db-errors';
import { lockTransferRow } from './ton-late-rows';
import { writeLate, type LateOutcome, type LateWrite } from './ton-late-writes';
import { lockAttempt, lockOrder } from './ton-row-locks';
import type { PrismaHolder } from './ton-transfer.repository';
import type { OrderMessage } from './ton-tx-hint.verifier';

// All Prisma access of the late chain facts (phase 5 S9f). The write is ONE transaction that locks
// in the order of docs/06 "Qulf tartibi": order -> attempt -> transfer (the order BEFORE a BOUNCED
// update, R4-1), like TonOutcomeRepository. A deadlock (40P01) rolled everything back, so the
// whole transaction runs again (at most DEADLOCK_TRIES times); a guard refusal (GG001) or a unique
// index (P2002: the seqno is held by another live transfer) is thrown to the caller, which raises
// the owner's alert (never silent, never retried here). No wallet lock: no money moves.

const DEADLOCK_TRIES = 3;

/** What a late look needs of one transfer: the signed message, the chain data, its attempt. */
export interface LateTransfer {
  readonly id: string;
  readonly purpose: string;
  readonly network: string;
  readonly walletAddress: string;
  readonly seqno: number;
  readonly validUntil: Date;
  readonly toAddress: string;
  readonly amountNanoTon: bigint;
  readonly payloadHash: string;
  readonly extMsgHash: string;
  readonly status: TonTransferStatus;
  readonly txHash: string | null;
  readonly txLt: bigint | null;
  readonly createdAt: Date;
  readonly orderId: string | null;
  readonly orderStatus: OrderStatus | null;
  readonly response: Prisma.JsonValue | null;
}

export interface LateApplied extends LateWrite {
  readonly orderId: string | null;
}

@Injectable()
export class TonLateRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaHolder) {}

  async read(transferId: string): Promise<LateTransfer | null> {
    const row = await this.prisma.client.tonTransfer.findUnique({
      where: { id: transferId },
      select: {
        id: true,
        purpose: true,
        network: true,
        walletAddress: true,
        seqno: true,
        validUntil: true,
        toAddress: true,
        amountNanoTon: true,
        payloadHash: true,
        extMsgHash: true,
        status: true,
        txHash: true,
        txLt: true,
        createdAt: true,
        attempt: { select: { response: true, order: { select: { id: true, status: true } } } },
      },
    });
    if (row === null) return null;
    const { attempt, ...transfer } = row;
    return {
      ...transfer,
      orderId: attempt?.order.id ?? null,
      orderStatus: attempt?.order.status ?? null,
      response: attempt?.response ?? null,
    };
  }

  async orderOf(transferId: string): Promise<string | null> {
    const row = await this.prisma.client.tonTransfer.findUnique({
      where: { id: transferId },
      select: { attempt: { select: { orderId: true } } },
    });
    return row?.attempt?.orderId ?? null;
  }

  /** The signed messages of the OTHER transfers of the order (the hint check, review F3). */
  async orderMessages(orderId: string, transferId: string): Promise<OrderMessage[]> {
    const rows = await this.prisma.client.tonTransfer.findMany({
      where: { attempt: { orderId }, NOT: { id: transferId } },
      select: { id: true, extMsgHash: true },
    });
    return rows.map((row) => ({ transferId: row.id, extMsgHash: row.extMsgHash }));
  }

  async apply(transferId: string, outcome: LateOutcome): Promise<LateApplied> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.client.$transaction((tx) => this.applyIn(tx, transferId, outcome));
      } catch (error) {
        if (!isDeadlock(error) || attempt >= DEADLOCK_TRIES) throw error;
      }
    }
  }

  private async applyIn(tx: Tx, transferId: string, outcome: LateOutcome): Promise<LateApplied> {
    const head = await tx.tonTransfer.findUniqueOrThrow({
      where: { id: transferId },
      select: { attemptId: true, attempt: { select: { orderId: true } } },
    });
    const orderId = head.attempt?.orderId ?? null;
    const order = orderId === null ? null : await lockOrder(tx, orderId);
    const attempt = head.attemptId === null ? null : await lockAttempt(tx, head.attemptId);
    const transfer = await lockTransferRow(tx, transferId);
    if (transfer === null) throw new Error(`TonTransfer ${transferId} disappeared`);
    const write = await writeLate(
      tx,
      { transferId, transfer, orderId, order, attemptId: head.attemptId, attempt },
      outcome,
    );
    return { ...write, orderId };
  }
}

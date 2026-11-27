import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@repo/db';
import { PrismaService } from '../infra/prisma/prisma.service';
import { isDeadlock } from './ton-db-errors';
import { isUnresolved } from './ton-payout';
import { lockAttempt, lockOrder, lockTransfer, withTonFacts } from './ton-row-locks';
import { scanCursorJson, storedScanProgress, type ScanBinding } from './ton-scan-cursor';
import type { PrismaHolder } from './ton-transfer.repository';
import type { ScanProgress } from './ton-tx-scan';

// Reads and writes the scan cursor of an ORDER transfer (`FulfillmentAttempt.response.ton.scan`,
// phase 5 S9, L-2). A SELFTEST transfer has no attempt: its progress stays in the memory of the one
// CLI process that watches it. The write takes the payout locks in the order of docs/06 (order ->
// attempt -> transfer) and happens only while the transfer is unresolved: a decided transfer's
// cursor is history, never moved again. Nothing else of the response changes (withTonFacts).

/** The transfer whose cursor is kept: its attempt (null for a SELFTEST) and its message. */
export interface CursorTransfer extends ScanBinding {
  readonly attemptId: string | null;
}

const DEADLOCK_TRIES = 3;

@Injectable()
export class TonScanCursorRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaHolder) {}

  /** The kept progress for exactly this transfer and message, or null. */
  async load(transfer: CursorTransfer): Promise<ScanProgress | null> {
    if (transfer.attemptId === null) return null;
    const attempt = await this.prisma.client.fulfillmentAttempt.findUnique({
      where: { id: transfer.attemptId },
      select: { response: true },
    });
    return attempt === null ? null : storedScanProgress(attempt.response, transfer);
  }

  /** Keeps the progress; false when nothing was written (no attempt, or already decided). */
  async save(transfer: CursorTransfer, progress: ScanProgress): Promise<boolean> {
    const attemptId = transfer.attemptId;
    if (attemptId === null) return false;
    for (let tries = 1; ; tries += 1) {
      try {
        return await this.prisma.client.$transaction((tx) =>
          this.saveIn(tx, transfer, attemptId, progress),
        );
      } catch (error) {
        // A deadlock rolled everything back: nothing was written, the whole write may run again.
        if (!isDeadlock(error) || tries >= DEADLOCK_TRIES) throw error;
      }
    }
  }

  private async saveIn(
    tx: Tx,
    transfer: CursorTransfer,
    attemptId: string,
    progress: ScanProgress,
  ): Promise<boolean> {
    const head = await tx.fulfillmentAttempt.findUnique({
      where: { id: attemptId },
      select: { orderId: true },
    });
    if (head === null) return false;
    await lockOrder(tx, head.orderId);
    const attempt = await lockAttempt(tx, attemptId);
    const status = await lockTransfer(tx, transfer.id);
    if (attempt === null || status === null || !isUnresolved(status)) return false;
    await tx.fulfillmentAttempt.update({
      where: { id: attemptId },
      data: {
        response: withTonFacts(attempt.response, { scan: scanCursorJson(transfer, progress) }),
      },
    });
    return true;
  }
}

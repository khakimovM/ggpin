import { Injectable } from '@nestjs/common';
import type {
  AdminAdjustWalletResponse,
  AdminCardChangeResponse,
  AdminNoteResponse,
  AdminPaymentReverseResponse,
  AdminReviewCreditResponse,
  AdminUserSessionsRevokeResponse,
  AdminUserStateResponse,
} from '@repo/shared';
import { AppError } from '../../../common/exceptions/app-error';
import { AdminPaymentsReadService } from '../payments/admin-payments-read.service';
import { AdminWriteRepository, afterField, type AdminAuditRow } from './admin-write.repository';

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The answer to a replayed admin write (docs/04 «Admin» — `Idempotency-Key`): the first call's
 * result rebuilt from its AuditLog row, `applied: false`, nothing written. What the row fixed
 * (ids, amounts, sessions ended) comes from the row; what changes (balance, flags, the card) is
 * read now, as the owner CLI's replays do.
 */
@Injectable()
export class AdminWriteReplays {
  constructor(
    private readonly repo: AdminWriteRepository,
    private readonly payments: AdminPaymentsReadService,
  ) {}

  async userState(row: AdminAuditRow): Promise<AdminUserStateResponse> {
    const flags = await this.repo.userFlags(row.targetId);
    if (flags === null) throw new AppError('NOT_FOUND');
    return {
      userId: row.targetId,
      ...flags,
      revokedSessions: count(afterField(row, 'revokedSessions')),
      auditId: row.id,
      applied: false,
    };
  }

  sessions(row: AdminAuditRow): Promise<AdminUserSessionsRevokeResponse> {
    return Promise.resolve({
      userId: row.targetId,
      revokedSessions: count(afterField(row, 'revokedSessions')),
      auditId: row.id,
      applied: false,
    });
  }

  async note(row: AdminAuditRow): Promise<AdminNoteResponse> {
    const author = row.actorId ?? '';
    return {
      note: {
        id: row.id,
        text: text(afterField(row, 'text')) ?? '',
        createdAt: row.createdAt.toISOString(),
        author: { id: author, name: await this.repo.adminName(author) },
      },
      auditId: row.id,
      applied: false,
    };
  }

  async adjust(row: AdminAuditRow): Promise<AdminAdjustWalletResponse> {
    const ledgerEntryId = await this.repo.ledgerEntryId('ADMIN_ACTION', row.id, 'ADJUSTMENT');
    if (ledgerEntryId === null) throw new AppError('INTERNAL_ERROR');
    return {
      ledgerEntryId,
      ...(await this.wallet(row.targetId)),
      auditId: row.id,
      applied: false,
    };
  }

  async reverse(row: AdminAuditRow): Promise<AdminPaymentReverseResponse> {
    const ledgerEntryId = await this.repo.ledgerEntryId('PAYMENT', row.targetId, 'TOPUP_REVERSAL');
    const userId = await this.repo.paymentUserId(row.targetId);
    if (ledgerEntryId === null || userId === null) throw new AppError('INTERNAL_ERROR');
    return {
      paymentId: row.targetId,
      userId,
      ledgerEntryId,
      ...(await this.wallet(userId)),
      auditId: row.id,
      applied: false,
    };
  }

  credit(row: AdminAuditRow): Promise<AdminReviewCreditResponse> {
    const paymentId = text(afterField(row, 'paymentId'));
    const userId = text(afterField(row, 'userId'));
    const amountTiyin = text(afterField(row, 'amountTiyin'));
    if (paymentId === null || userId === null || amountTiyin === null) {
      throw new AppError('INTERNAL_ERROR');
    }
    return Promise.resolve({
      reviewId: row.targetId,
      paymentId,
      userId,
      intentId: text(afterField(row, 'intentId')),
      amountTiyin,
      auditId: row.id,
      applied: false,
    });
  }

  async card(row: AdminAuditRow): Promise<AdminCardChangeResponse> {
    return {
      card: await this.payments.card(row.targetId),
      cancelledIntents: count(afterField(row, 'cancelledIntents')),
      auditId: row.id,
      applied: false,
    };
  }

  private async wallet(userId: string): Promise<{ balanceTiyin: string; frozen: boolean }> {
    const flags = await this.repo.userFlags(userId);
    if (flags === null) throw new AppError('NOT_FOUND');
    const balance = await this.repo.balance(userId);
    return { balanceTiyin: balance.toString(), frozen: flags.purchaseFrozen };
  }
}

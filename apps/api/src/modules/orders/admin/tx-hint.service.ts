import { Inject, Injectable } from '@nestjs/common';
import { TonTxHintSchema, type TonTxHint } from '@repo/shared';
import { checkedReason, validationError } from '../../../common/admin/admin-input';
import { AppError } from '../../../common/exceptions/app-error';
import { OrderAdminEffects } from './order-admin-effects';
import { asRefusal, retryOnDeadlock } from './order-admin-errors';
import {
  CLI_OWNER_AUDIT_ACTOR,
  OPERATOR_CHANNEL,
  assertOwnerChannel,
  checkedActor,
  type OperatorChannel,
} from './operator-channel';
import { TonHintRepository, type StoredHintRow } from './tx-hint.repository';

// `ton:hint <transferId> --tx <hash> --lt <lt>` (phase 5 S9f, D-64 (7), Q-7): the owner names the
// transaction that may carry a CONSUMED_UNMATCHED transfer's payment (Z6). Only the owner CLI
// channel may write it (assertOwnerChannel); the reason is at least HINT_REASON_MIN characters.
// One AuditLog row TON_TX_HINT (targetType TonTransfer), nothing else: no money moves, no state
// changes, so no owner code is asked. The worker checks the hint on the primary source and on at
// least one witness (account, seqno, payee on the allowlist, amount, payload, no bounce) before it
// writes anything; its verdict is kept on the attempt and `order:show` prints it. The same hint
// again (the transfer's latest hint names the same transaction) writes nothing a second time,
// unless the worker REJECTED that latest hint: a source may have lagged, so the owner may ask
// again and a new row is written (review F2, audit L-3). Only an ORDER transfer takes a hint
// (audit I-7: a testnet self-test transfer has no order to settle).

/** The plan's floor for a hint's reason (Q-7): the owner says where the transaction was found. */
export const HINT_REASON_MIN = 20;

export interface TonHintInput {
  readonly transferId: string;
  /** 64 lowercase hex (the CLI lowercases what was typed before it calls). */
  readonly txHash: string;
  readonly lt: string;
  readonly reason: string;
  readonly operator: string;
  readonly ip?: string | null;
  readonly osUser?: string | null;
}

export interface TonHintOutcome {
  /** False: the transfer's latest hint already names this transaction (nothing written). */
  readonly applied: boolean;
  readonly transferId: string;
  readonly orderId: string | null;
  readonly auditId: string;
  readonly adminAction: boolean;
}

/** The hint in the shared shape, or a VALIDATION_ERROR naming the first field that is wrong. */
function checkedHint(input: TonHintInput): TonTxHint {
  const parsed = TonTxHintSchema.safeParse({
    transferId: input.transferId,
    txHash: input.txHash,
    lt: input.lt,
  });
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path[0];
  throw validationError(typeof field === 'string' ? field : 'hint');
}

@Injectable()
export class TonHintService {
  constructor(
    private readonly repo: TonHintRepository,
    private readonly effects: OrderAdminEffects,
    @Inject(OPERATOR_CHANNEL) private readonly channel: OperatorChannel,
  ) {}

  async hint(input: TonHintInput): Promise<TonHintOutcome> {
    assertOwnerChannel(this.channel);
    const hint = checkedHint(input);
    const reason = checkedReason(input.reason);
    if (reason.length < HINT_REASON_MIN) throw validationError('reason', 'TOO_SHORT');
    const actor = checkedActor(input);
    let committed: { readonly applied: boolean; readonly auditId: string; orderId: string | null };
    try {
      committed = await retryOnDeadlock(() =>
        this.repo.transaction(async (tx) => {
          const transfer = await this.repo.transfer(tx, hint.transferId);
          if (transfer?.purpose !== 'ORDER') throw new AppError('NOT_FOUND');
          if (transfer.status !== 'CONSUMED_UNMATCHED') {
            throw validationError('transfer', 'NOT_CONSUMED_UNMATCHED');
          }
          const latest = await this.repo.latestHint(tx, hint.transferId);
          const rejected =
            latest !== null &&
            transfer.verdict?.auditId === latest.id &&
            transfer.verdict.verdict === 'REJECTED';
          if (latest?.txHash === hint.txHash && latest.lt === hint.lt && !rejected) {
            return { applied: false, auditId: latest.id, orderId: transfer.orderId };
          }
          const audit = await this.repo.createHint(tx, {
            transferId: hint.transferId,
            before: { status: transfer.status, seqno: transfer.seqno },
            after: {
              txHash: hint.txHash,
              lt: hint.lt,
              operator: actor.operator,
              osUser: actor.osUser,
              actor: CLI_OWNER_AUDIT_ACTOR,
            },
            reason,
            ip: actor.ip,
          });
          return { applied: true, auditId: audit.id, orderId: transfer.orderId };
        }),
      );
    } catch (error) {
      throw asRefusal(error);
    }
    const adminAction = committed.applied
      ? await this.effects.adminAction(committed.auditId)
      : false;
    return { ...committed, transferId: hint.transferId, adminAction };
  }

  /** The owner's hints of these transfers, newest first (`order:show`; a read, any channel). */
  hintsOf(transferIds: readonly string[]): Promise<StoredHintRow[]> {
    return this.repo.hintsOf(transferIds);
  }
}

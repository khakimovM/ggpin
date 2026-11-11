import { randomBytes } from 'node:crypto';
import { appendLedgerEntry } from '@repo/db';
import { notifyJobId, walletCacheKey, type NotifyJob } from '@repo/shared';
import type { PaymentsE2e } from './payments-e2e.helpers';

// What the worker's matcher leaves behind when it credits a request, written by the test because
// the API may not import worker code (eslint WORKER_ONLY_PATTERNS, CLAUDE.md section 5.7). The
// worker half of the same flow runs for real in apps/worker .../topup-flow.e2e-spec.ts; this is
// the shape of ITS output, accepted by the same database guards (PARSED CREDIT message, CONFIRMED
// payment, intent PAID with reservedUntil = GREATEST(old, paidAt + grace), TOPUP entry in the
// same transaction), followed by the two post-commit effects: the wallet cache DEL and the
// `notify` job with the jobId the worker uses.

export interface Settle {
  readonly intentId: string;
  readonly userId: string;
  readonly cardId: string;
  readonly last4: string;
  readonly amountTiyin: bigint;
  /** The money came after the request's deadline (the worker's isLatePayment). */
  readonly late: boolean;
}

export async function settleIntent(e2e: PaymentsE2e, s: Settle): Promise<string> {
  const db = e2e.db();
  const intent = await db.paymentIntent.findUniqueOrThrow({ where: { id: s.intentId } });
  const senderId = 930_000_000_000n;
  const tgMessageId = BigInt(`0x${randomBytes(6).toString('hex')}`);
  const paidAt = new Date();
  const grace = (intent.reservedUntil?.getTime() ?? 0) - intent.expiresAt.getTime();
  const paymentId = await db.$transaction(async (tx) => {
    const message = await tx.bankMessage.create({
      data: {
        source: 'UZCARD_BOT',
        senderId,
        tgMessageId,
        tgDate: paidAt,
        textSha256: randomBytes(32).toString('hex'),
        parseStatus: 'PARSED',
        parserVersion: 1,
        direction: 'CREDIT',
        amountTiyin: s.amountTiyin,
        balanceAfterTiyin: s.amountTiyin + 10_000_000n,
        last4: s.last4,
        cardId: s.cardId,
        bankTxnAt: paidAt,
      },
    });
    const payment = await tx.payment.create({
      data: {
        intentId: s.intentId,
        userId: s.userId,
        provider: 'P2P_CARD',
        providerTxnId: `${senderId.toString()}:${tgMessageId.toString()}`,
        amountTiyin: s.amountTiyin,
        status: 'CONFIRMED',
        raw: {},
        bankMessageId: message.id,
        confirmedAt: paidAt,
      },
    });
    await tx.paymentIntent.update({
      where: { id: s.intentId },
      data: {
        status: 'PAID',
        paidAt,
        reservedUntil: new Date(
          Math.max(intent.reservedUntil?.getTime() ?? 0, paidAt.getTime() + grace),
        ),
      },
    });
    await appendLedgerEntry(tx, {
      userId: s.userId,
      kind: 'TOPUP',
      amountTiyin: s.amountTiyin,
      refType: 'PAYMENT',
      refId: payment.id,
    });
    return payment.id;
  });
  // After the commit, like the worker's effects.
  await e2e.redis().del(walletCacheKey(s.userId));
  const job: NotifyJob = {
    kind: s.late ? 'TOPUP_LATE_CREDITED' : 'TOPUP_CREDITED',
    refId: paymentId,
  };
  await e2e.notifyQueue().add('notify', job, { jobId: notifyJobId(job) });
  return paymentId;
}

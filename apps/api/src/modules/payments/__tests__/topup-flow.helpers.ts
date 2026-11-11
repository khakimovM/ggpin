import { getQueueToken } from '@nestjs/bullmq';
import {
  QUEUES,
  TopupIntentCreatedSchema,
  WalletResponseSchema,
  notifyJobId,
  notifyJobSchema,
  ownerAlertChatIds,
  ownerAlertOutboxJobId,
  webAppLoginResponseSchema,
} from '@repo/shared';
import type { Queue } from 'bullmq';
import { nextTestTelegramId } from '../../../config/__tests__/test-telegram-id';
import { buildInitData } from '../../auth/__tests__/init-data.fixtures';
import { NotifyConsumer } from '../../notifications/notify.consumer';
import { TgOutboxConsumer } from '../../notifications/tg-outbox.consumer';
import type { PaymentsE2e, TestUser } from './payments-e2e.helpers';

// Steps shared by the full top-up flow specs: a real Mini App login, a request on a fresh
// UZCARD card, the balance read, and the two consumers a notify job passes through.

export interface Payer extends TestUser {
  readonly telegramId: number;
}

/** formatMoney groups digits with no-break spaces; compare with plain ones. */
export const flat = (text: string): string => text.replace(/\s/g, ' ');

export const credit = (
  last4: string,
  amountTiyin: bigint,
  extra: { tgMessageId?: bigint; at?: Date } = {},
) => ({ last4, amountTiyin, balanceAfterTiyin: 60_000_000n, ...extra });

export function flowKit(e2e: PaymentsE2e, outboxIds: Set<string>) {
  /** A real Mini App login: signed initData -> POST /auth/telegram/webapp -> our session token. */
  async function login(): Promise<Payer> {
    const telegramId = nextTestTelegramId();
    const initData = buildInitData({
      botToken: e2e.env.TELEGRAM_BOT_TOKEN,
      authDate: Math.floor(Date.now() / 1000) - 5,
      user: {
        id: telegramId,
        first_name: 'Payer',
        username: `flow_${telegramId}`,
        language_code: 'uz',
      },
    });
    const res = await e2e.send(
      'POST',
      '/auth/telegram/webapp',
      { 'x-csrf-token': 'e2e', origin: e2e.env.WEB_URL },
      { initData },
    );
    expect(res.status).toBe(200);
    const parsed = webAppLoginResponseSchema.parse(res.body.data);
    return { id: parsed.user.id, telegramId, bearer: { authorization: `Bearer ${parsed.token}` } };
  }

  async function walletOf(user: TestUser): Promise<string> {
    const res = await e2e.get('/me/wallet', user);
    expect(res.status).toBe(200);
    return WalletResponseSchema.parse(res.body.data).balanceTiyin;
  }

  /** A user with a request on a fresh UZCARD card, plus the exact amount to transfer. */
  async function requestTopup() {
    const card = await e2e.card({ bank: 'UZCARD' });
    const user = await login();
    const res = await e2e.create(user);
    expect(res.status).toBe(201);
    const intent = TopupIntentCreatedSchema.parse(res.body.data);
    return { card, user, intent, amount: BigInt(intent.payAmountTiyin) };
  }

  async function ledgerSum(userId: string): Promise<bigint> {
    const sum = await e2e
      .db()
      .ledgerEntry.aggregate({ where: { userId }, _sum: { amountTiyin: true } });
    return sum._sum.amountTiyin ?? 0n;
  }

  /**
   * The queued notify job through the API's notify consumer, then its outbox job through the
   * tg-outbox consumer (whose sender the spec made a fake).
   */
  async function deliver(jobId: string) {
    const job = await e2e.notifyQueue().getJob(jobId);
    expect(job).toBeDefined();
    const data = notifyJobSchema.parse(job?.data);
    await expect(e2e.app().get(NotifyConsumer).handle({ id: jobId, data })).resolves.toBe('queued');
    // An owner alert is one outbox job per partner (D-53); every other notice is one job.
    const outboxJobIds =
      data.kind === 'OWNER_ALERT'
        ? ownerAlertChatIds(e2e.env.OWNER_ALERT_CHAT_ID).map((chatId) =>
            ownerAlertOutboxJobId(data, chatId),
          )
        : [notifyJobId(data)];
    for (const outboxJobId of outboxJobIds) {
      const outJob = await e2e
        .app()
        .get<Queue>(getQueueToken(QUEUES.TG_OUTBOX))
        .getJob(outboxJobId);
      if (outJob === undefined) throw new Error('no tg-outbox job was queued');
      outboxIds.add(outboxJobId);
      await e2e.app().get(TgOutboxConsumer).handle(outJob, 'e2e-token');
    }
    return data;
  }

  return { login, walletOf, requestTopup, ledgerSum, deliver };
}

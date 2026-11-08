import { QUEUES, bankMessageJobId } from '@repo/shared';
import { Queue } from 'bullmq';
import type { BankFeedMessage } from '../../../apps/worker/src/bank-feed/client/bank-feed-client';
import { FakeBankFeedClient } from '../../../apps/worker/src/bank-feed/client/fake-bank-feed.client';
import { IngestService } from '../../../apps/worker/src/bank-feed/client/ingest.service';
import { cardLimitJobId } from '../../../apps/worker/src/bank-feed/card-limit-scheduler';
import {
  bootMatcher,
  TestHooks,
  type MatcherInstance,
} from '../../../apps/worker/src/bank-feed/__tests__/matcher-e2e.harness';
import { uzcardText } from '../../../apps/worker/src/bank-feed/__tests__/synthetic-message';
import { buildE2eEnv } from '../../../apps/worker/src/config/__tests__/e2e-env';
import type { Env } from '../../../apps/worker/src/config/env';

// The worker side of the full top-up flow: the REAL bank-feed module (ingest, matcher,
// BankMessageProcessor, effects) on the shared ggpin_test Postgres + Redis DB 15, with the
// listener replaced by the in-memory fake client (what BANK_FEED_MODE=fake stands for) and no
// BullMQ Worker: the queued `bank-message` job is read back and handed to the processor, as the
// BullMQ worker would. The worker's env is its own object (buildE2eEnv of apps/worker) and is
// never given to the API app, so no worker secret reaches it. All bank values are SYNTHETIC.

const runSeed = BigInt(Date.now());
/** The pinned "bot" of this run; also the private chat id of the fake bot chat. */
const SENDER_ID = 920_000_000_000n + (runSeed % 1_000_000n);
let messageSeq = runSeed * 1_000n;

export interface Credit {
  /** Telegram's message id; give the same id (and `at`) again to replay a message. */
  readonly tgMessageId?: bigint;
  readonly last4: string;
  readonly amountTiyin: bigint;
  readonly balanceAfterTiyin?: bigint;
  /** The time Telegram and the bank print; default 1 minute ago (a message is never from the future). */
  readonly at?: Date;
}

export type Received =
  | { readonly stored: true; readonly tgMessageId: bigint; readonly bankMessageId: string }
  | { readonly stored: false; readonly tgMessageId: bigint; readonly reason: string };

export class WorkerSide {
  private readonly client = new FakeBankFeedClient();
  private readonly stored = new Set<string>();

  private constructor(
    private readonly matcher: MatcherInstance,
    private readonly ingest: IngestService,
    private readonly bankMessages: Queue,
    private readonly limits: Queue,
  ) {}

  static async boot(): Promise<WorkerSide> {
    // This run's synthetic bot is the pinned sender of both sources (MessageIntegrity).
    const env: Env = {
      ...buildE2eEnv(),
      BANK_FEED_HUMO_BOT_ID: SENDER_ID,
      BANK_FEED_UZCARD_BOT_ID: SENDER_ID,
    };
    if (!env.FULFILLMENT_DRY_RUN) throw new Error('the flow e2e needs FULFILLMENT_DRY_RUN=true');
    const matcher = await bootMatcher(env, new TestHooks());
    const connection = { connection: { url: env.REDIS_URL } };
    return new WorkerSide(
      matcher,
      matcher.moduleRef.get(IngestService),
      new Queue(QUEUES.BANK_MESSAGE, connection),
      new Queue(QUEUES.CARD_LIMIT, connection),
    );
  }

  /** A CREDIT appears in the fake Uzcard-bot chat; it is read back with the client contract and ingested. */
  async receive(credit: Credit): Promise<Received> {
    messageSeq += 1n;
    const id = credit.tgMessageId ?? messageSeq;
    const date = credit.at ?? new Date(Date.now() - 60_000);
    const message: BankFeedMessage = {
      id,
      date,
      chatId: SENDER_ID,
      senderId: SENDER_ID,
      senderIsBot: true,
      text: uzcardText({
        direction: 'CREDIT',
        amountTiyin: credit.amountTiyin,
        balanceAfterTiyin: credit.balanceAfterTiyin ?? 60_000_000n,
        last4: credit.last4,
        bankTxnAt: date,
      }),
      outgoing: false,
      forwarded: false,
      editDate: null,
      viaBotId: null,
    };
    this.client.clear();
    this.client.put('UZCARD_BOT', message);
    const [fetched] = await this.client.fetchSince('UZCARD_BOT', id - 1n, 1);
    if (fetched === undefined) throw new Error('the fake chat returned nothing');
    const result = await this.ingest.ingest('UZCARD_BOT', fetched);
    if (!result.stored) return { stored: false, tgMessageId: id, reason: result.reason };
    this.stored.add(result.bankMessageId);
    return { stored: true, tgMessageId: id, bankMessageId: result.bankMessageId };
  }

  async hasJob(bankMessageId: string): Promise<boolean> {
    return (await this.bankMessages.getJob(bankMessageJobId(bankMessageId))) !== undefined;
  }

  /** What the BullMQ worker does: the queued `bank-message` job goes through the real processor. */
  async runJob(bankMessageId: string): Promise<string> {
    const job = await this.bankMessages.getJob(bankMessageJobId(bankMessageId));
    if (job === undefined) throw new Error('no bank-message job for this row');
    return this.matcher.processor.process(job);
  }

  /** Removes the jobs this run queued and closes every connection. */
  async close(): Promise<void> {
    for (const id of this.stored) {
      await (await this.bankMessages.getJob(bankMessageJobId(id)))?.remove();
      await (await this.limits.getJob(cardLimitJobId(id)))?.remove();
    }
    await this.bankMessages.close();
    await this.limits.close();
    await this.matcher.moduleRef.close();
  }
}

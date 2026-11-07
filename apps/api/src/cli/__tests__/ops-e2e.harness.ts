import { randomBytes, randomInt } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { PaymentReviewKind, TopupCard } from '@repo/db';
import { QUEUES, walletCacheKey } from '@repo/shared';
import type { Queue } from 'bullmq';
import { buildE2eEnv } from '../../config/__tests__/e2e-env';
import { nextTestTelegramId } from '../../config/__tests__/test-telegram-id';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { TEST_HOLDER, syntheticPan } from '../../modules/payments/__tests__/payments.fixtures';
import { OpsCliModule } from '../ops-cli.module';
import { findCommand, runCommand } from '../ops-cli.runner';
import {
  TEST_OWNER_CHAT_ID,
  sentCodeFor,
} from '../../common/admin/owner-otp/__tests__/owner-otp.testing';
import type { CliSession } from '../cli-session';
import { scriptedIo, type Answer } from './scripted-io';

// The owner CLI's real module graph (OpsCliModule) on the *_test database and Redis DB 15.
// Rows are synthetic (E-29: no real card digits, names or times) and never deleted (restricted
// references, append-only audit); cards are retired at the end so their last4 are free again,
// and the notify jobs the commands queued are removed. Nothing reaches Telegram.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
const GRACE_MS = 24 * HOUR;
export const ACTOR = { operator: 'e2e-owner', ip: '203.0.113.9' };
/** A local console run (no SSH) by a synthetic OS account. */
export const LOCAL_SESSION: CliSession = { sshIp: null, osUser: 'e2e-os-user' };

export interface MessageOptions {
  readonly card: TopupCard | null;
  readonly amountTiyin?: bigint;
  readonly direction?: 'CREDIT' | 'DEBIT';
  readonly parsed?: boolean;
  readonly text?: string;
  /** Default a minute ago (BankMessage is append-only: set it here). */
  readonly tgDate?: Date;
}

export interface IntentOptions {
  readonly cardId: string;
  readonly amountTiyin: bigint;
  readonly status: 'PENDING' | 'EXPIRED' | 'CANCELLED';
  /** Default 10 minutes ago. */
  readonly createdAt?: Date;
}

export function useOpsE2e() {
  // The owner's chat for the one-time codes (D-46): synthetic, never reached (no outbox worker).
  const env = buildE2eEnv({ OWNER_ALERT_CHAT_ID: TEST_OWNER_CHAT_ID });
  let moduleRef: TestingModule;
  const cardIds: string[] = [];
  const jobIds = new Set<string>();
  const db = (): PrismaService['client'] => moduleRef.get(PrismaService).client;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [OpsCliModule.register(env)],
    }).compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
  });

  afterAll(async () => {
    await db().topupCard.updateMany({
      where: { id: { in: cardIds }, status: { not: 'RETIRED' } },
      data: { status: 'RETIRED', retiredAt: new Date() },
    });
    const queue = moduleRef.get<Queue>(getQueueToken(QUEUES.NOTIFY));
    for (const id of jobIds) await queue.remove(id).catch(() => 0);
    await moduleRef.close();
  });

  const user = async (): Promise<string> => {
    const row = await db().user.create({
      data: {
        telegramId: BigInt(nextTestTelegramId()),
        firstName: 'Payer',
        referralCode: `e2e${randomBytes(6).toString('hex')}`,
        wallet: { create: {} },
      },
      select: { id: true },
    });
    return row.id;
  };

  const card = async (opts: { paused?: boolean } = {}): Promise<TopupCard> => {
    for (let attempt = 0; ; attempt += 1) {
      const pan = syntheticPan();
      try {
        const row = await db().topupCard.create({
          data: {
            bank: 'HUMO',
            pan,
            last4: pan.slice(-4),
            holderName: TEST_HOLDER,
            status: 'ACTIVE',
            receiveLimitTiyin: 900_000_000_000_000n,
            verifyAmountTiyin: 100_100n,
            verifiedAt: new Date(Date.now() - 10 * 24 * HOUR),
            autoCreditPaused: opts.paused ?? false,
          },
        });
        cardIds.push(row.id);
        return row;
      } catch (error) {
        if (attempt === 9) throw error; // a (bank, last4) clash with a live card: new PAN
      }
    }
  };

  const message = async (o: MessageOptions) => {
    const parsed = o.parsed ?? true;
    const amountTiyin = o.amountTiyin ?? 5_000_000n + BigInt(randomInt(1, 999)) * 100n;
    const last4 = o.card?.last4 ?? String(randomInt(10_000)).padStart(4, '0');
    const row = await db().bankMessage.create({
      data: {
        source: 'HUMO_BOT',
        senderId: 777_000_000_000n + BigInt(randomInt(1_000_000)),
        tgMessageId: BigInt(`0x${randomBytes(6).toString('hex')}`),
        tgDate: o.tgDate ?? new Date(Date.now() - MINUTE),
        textSha256: randomBytes(32).toString('hex'),
        parseStatus: parsed ? 'PARSED' : 'UNRECOGNIZED',
        rejectReason: parsed ? null : 'AMOUNT_FORMAT',
        parserVersion: 1,
        ...(parsed
          ? {
              direction: o.direction ?? 'CREDIT',
              amountTiyin,
              balanceAfterTiyin: amountTiyin + 7n,
              last4,
              bankTxnAt: o.tgDate ?? new Date(Date.now() - MINUTE),
            }
          : {}),
        cardId: o.card?.id ?? null,
        rawText: {
          create: {
            text: o.text ?? 'synthetic bank text',
            purgeAfter: new Date(Date.now() + 365 * 24 * HOUR),
          },
        },
      },
    });
    return row;
  };

  const review = async (
    messageId: string,
    kind: PaymentReviewKind,
    extra: { cardId?: string | null; intentId?: string } = {},
  ): Promise<string> => {
    const row = await db().paymentReview.create({
      data: {
        bankMessageId: messageId,
        kind,
        cardId: extra.cardId ?? null,
        intentId: extra.intentId ?? null,
      },
      select: { id: true },
    });
    return row.id;
  };

  const intent = async (userId: string, o: IntentOptions): Promise<string> => {
    const tag = randomBytes(8).toString('hex');
    const createdAt = o.createdAt ?? new Date(Date.now() - 10 * MINUTE);
    const expiresAt = new Date(createdAt.getTime() + 30 * MINUTE);
    const suffix = o.amountTiyin % 100_000n;
    const row = await db().paymentIntent.create({
      data: {
        userId,
        provider: 'P2P_CARD',
        cardId: o.cardId,
        baseAmountTiyin: o.amountTiyin - suffix,
        amountTiyin: o.amountTiyin,
        status: o.status,
        purpose: 'TOPUP',
        idempotencyKey: `ops_${tag}`,
        requestHash: `ops_${tag}`,
        createdAt,
        expiresAt,
        reservedUntil: new Date(expiresAt.getTime() + GRACE_MS),
      },
      select: { id: true },
    });
    return row.id;
  };

  /** Runs one CLI command the way ops-cli.ts does, against this file's module graph. */
  const run = async (
    argv: readonly string[],
    answers: readonly Answer[] = [],
    session: CliSession = LOCAL_SESSION,
  ) => {
    const [name, ...rest] = argv;
    const command = findCommand(name);
    if (command === undefined) throw new Error(`no command ${String(name)}`);
    const terminal = scriptedIo(answers);
    const code = await runCommand(command, rest, moduleRef, terminal.io, session);
    return { code, ...terminal };
  };

  return {
    env,
    db,
    app: () => moduleRef,
    user,
    card,
    message,
    review,
    intent,
    run,
    /** The answer "the code from the bot" for the code that names `target` (read when asked). */
    codeFor:
      (target: string): Answer =>
      () =>
        sentCodeFor(moduleRef, target),
    /** A notify job id to look up now and remove after the file. */
    async notifyJob(jobId: string) {
      jobIds.add(jobId);
      return moduleRef.get<Queue>(getQueueToken(QUEUES.NOTIFY)).getJob(jobId);
    },
    async cachedBalance(userId: string, value: string | null) {
      const redis = moduleRef.get(RedisService).client;
      if (value === null) return redis.get(walletCacheKey(userId));
      await redis.set(walletCacheKey(userId), value);
      return value;
    },
    audit: (id: string) => db().auditLog.findUniqueOrThrow({ where: { id } }),
  };
}

export type OpsE2e = ReturnType<typeof useOpsE2e>;

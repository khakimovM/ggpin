import { nextTestTelegramId } from '../../../config/__tests__/test-telegram-id';
import { randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { LedgerKind } from '@repo/db';
import { QUEUES } from '@repo/shared';
import type { Queue } from 'bullmq';
import {
  queueJobIds,
  removeJobsAddedSince,
} from '../../../infra/queue/__tests__/queue-jobs-cleanup';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { createHttpAdapter } from '../../../common/http/create-http-adapter';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { TokenCodec } from '../../auth/token-codec';
import { UsersService } from '../../users/users.service';
import {
  buildOrdersCatalog,
  insertPaidOrder,
  insertQuote,
  type OrdersCatalog,
} from '../../orders/__tests__/orders-e2e.fixtures';
import { WalletAdminService } from '../wallet-admin.service';
import {
  createP2pPayment,
  retireCards,
  type P2pPayment,
  type P2pPaymentOptions,
} from './wallet-p2p-fixture';

export interface Envelope {
  readonly success: boolean;
  readonly data?: unknown;
  readonly meta?: { page: number; limit: number; total: number };
  readonly error?: { readonly code: string; readonly details?: unknown };
}

export interface TestUser {
  readonly id: string;
  readonly bearer: Record<string, string>;
}

export interface WalletE2e {
  readonly app: () => NestFastifyApplication;
  readonly db: () => PrismaService['client'];
  readonly redis: () => RedisService['client'];
  readonly admin: () => WalletAdminService;
  readonly notifyQueue: () => Queue;
  /** Remembers a notify job id so afterAll removes it from Redis. */
  readonly trackJob: (jobId: string) => void;
  /**
   * A ledger reference unique to this run. LedgerEntry rows can never be deleted (append-only
   * trigger), so a fixed refId would collide with the previous run on the persistent test DB.
   */
  readonly ref: (name: string) => string;
  readonly newUser: () => Promise<TestUser>;
  readonly get: (
    path: string,
    user: TestUser | null,
  ) => Promise<{ status: number; headers: Record<string, unknown>; body: Envelope }>;
  /**
   * A direct ledger insert (the test is the "other code path" that writes the ledger). A PURCHASE
   * (refType ORDER) comes with its order, id = refId, in the same transaction: the database refuses
   * a debit without its order of that user and amount (D-60).
   */
  readonly seedEntry: (
    userId: string,
    kind: LedgerKind,
    amountTiyin: bigint,
    ref: { refType: string; refId: string },
    createdAt?: Date,
  ) => Promise<string>;
  /** A real P2P_CARD shape (card, bank message, PAID intent, CONFIRMED payment, TOPUP entry). */
  readonly p2pPayment: (userId: string, options: P2pPaymentOptions) => Promise<P2pPayment>;
  /**
   * A provider-agnostic payment (CLICK, no card). CONFIRMED comes with its TOPUP entry; CREATED
   * (inserted as such, never updated into it) has none.
   */
  readonly clickPayment: (
    userId: string,
    amountTiyin: bigint,
    status?: 'CONFIRMED' | 'CREATED',
  ) => Promise<string>;
}

const FAR_FUTURE = new Date('2099-01-01T00:00:00.000Z');

// Boots the real app on the *_test database and Redis DB 15. LedgerEntry is append-only (a DB
// trigger refuses DELETE), and users, payments, intents and bank messages that reference ledger
// rows or each other are restricted, so a suite cannot delete what it created. It therefore uses
// only its own random users and ids, never reuses one, and cleans up what is removable: Redis
// keys, queue jobs, and the receiving cards (retired, so their last4 is free for the next run).
export function useWalletE2e(): WalletE2e {
  const env = buildE2eEnv();
  let app: NestFastifyApplication;
  let ipSeq = 0;
  const runTag = randomBytes(5).toString('hex');
  const userIds: string[] = [];
  const jobIds = new Set<string>();
  let notifyBefore = new Set<string>(); // B5: every notify job a file adds is removed after it
  const cardIds: string[] = [];
  let ordersCatalog: OrdersCatalog | undefined;

  const db = (): PrismaService['client'] => app.get(PrismaService).client;
  const nextIp = (): string => {
    ipSeq += 1;
    return `10.${String(Math.floor(ipSeq / 65536) % 256)}.${String(Math.floor(ipSeq / 256) % 256)}.${String((ipSeq % 255) + 1)}`;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(env)],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(env), {
      logger: false,
    });
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    notifyBefore = await queueJobIds(app.get<Queue>(getQueueToken(QUEUES.NOTIFY)));
  });

  afterAll(async () => {
    const redis = app.get(RedisService).client;
    await redis.del(...userIds.map((id) => `wallet:${id}`));
    const queue = app.get<Queue>(getQueueToken(QUEUES.NOTIFY));
    for (const id of jobIds) await queue.remove(id).catch(() => 0);
    await removeJobsAddedSince(queue, notifyBefore);
    await retireCards(db(), cardIds);
    await app.close();
  });

  const newUser = async (): Promise<TestUser> => {
    const now = new Date();
    // Unique across files, runs and jest workers (test-telegram-id.ts), under 2^53.
    const telegramId = nextTestTelegramId();
    const { user } = await app
      .get(UsersService)
      .ensureTelegramUser({ telegramId: BigInt(telegramId), firstName: 'Wallet' }, { now });
    userIds.push(user.id);
    const iat = Math.floor(now.getTime() / 1000);
    const token = app.get(TokenCodec).sign({ typ: 'tg', sub: user.id, iat, exp: iat + 3600 });
    return { id: user.id, bearer: { authorization: `Bearer ${token}` } };
  };

  const seedEntry: WalletE2e['seedEntry'] = async (userId, kind, amountTiyin, ref, createdAt) => {
    if (kind === 'PURCHASE' && ref.refType === 'ORDER') {
      ordersCatalog ??= await buildOrdersCatalog(db(), runTag);
      const quote = await insertQuote(db(), ordersCatalog, userId, { priceTiyin: -amountTiyin });
      const { entryId } = await insertPaidOrder(db(), quote, {
        id: ref.refId,
        ...(createdAt === undefined ? {} : { entryCreatedAt: createdAt }),
      });
      return entryId;
    }
    const row = await db().ledgerEntry.create({
      data: {
        userId,
        kind,
        amountTiyin,
        refType: ref.refType,
        refId: ref.refId,
        ...(createdAt === undefined ? {} : { createdAt }),
      },
      select: { id: true },
    });
    return row.id;
  };

  return {
    app: () => app,
    db,
    redis: () => app.get(RedisService).client,
    admin: () => app.get(WalletAdminService),
    notifyQueue: () => app.get<Queue>(getQueueToken(QUEUES.NOTIFY)),
    trackJob: (id) => {
      jobIds.add(id);
    },
    ref: (name) => `${name}_${runTag}`,
    newUser,
    get: async (path, user) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1${path}`,
        headers: user === null ? {} : user.bearer,
        remoteAddress: nextIp(),
      });
      return { status: res.statusCode, headers: res.headers, body: res.json<Envelope>() };
    },
    seedEntry,
    p2pPayment: (userId, options) =>
      createP2pPayment(
        db(),
        (paymentId, amountTiyin) =>
          seedEntry(userId, 'TOPUP', amountTiyin, { refType: 'PAYMENT', refId: paymentId }),
        cardIds,
        userId,
        options,
      ),
    clickPayment: async (userId, amountTiyin, status = 'CONFIRMED') => {
      const tag = randomBytes(6).toString('hex');
      const intent = await db().paymentIntent.create({
        data: {
          userId,
          provider: 'CLICK',
          amountTiyin,
          status: 'PENDING',
          purpose: 'TOPUP',
          idempotencyKey: `idem_${tag}`,
          requestHash: `hash_${tag}`,
          expiresAt: FAR_FUTURE,
        },
      });
      const payment = await db().payment.create({
        data: {
          intentId: intent.id,
          userId,
          provider: 'CLICK',
          providerTxnId: `click_${tag}`,
          amountTiyin,
          status,
          raw: {},
          ...(status === 'CONFIRMED' ? { confirmedAt: new Date() } : {}),
        },
      });
      if (status === 'CONFIRMED') {
        await seedEntry(userId, 'TOPUP', amountTiyin, { refType: 'PAYMENT', refId: payment.id });
      }
      return payment.id;
    },
  };
}

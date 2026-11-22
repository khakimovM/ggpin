import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { AdminUser, TopupCard } from '@repo/db';
import { QUEUES, tashkentDayKey, type AdminConfirmationBody } from '@repo/shared';
import type { Queue } from 'bullmq';
import { codeIn } from '../../../common/admin/owner-otp/__tests__/owner-otp.testing';
import { nextTestTelegramId } from '../../../config/__tests__/test-telegram-id';
import {
  queueJobIds,
  removeJobsAddedSince,
} from '../../../infra/queue/__tests__/queue-jobs-cleanup';
import { TEST_HOLDER, syntheticPan } from '../../payments/__tests__/payments.fixtures';
import { RedisService } from '../../../infra/redis/redis.service';
import { TokenCodec } from '../../auth/token-codec';
import { adminOtpJobId, adminOtpKey, adminOtpQuotaKey } from '../confirm/admin-otp.keys';
import type { AdminE2e, Res } from './admin-e2e.api';

// Test kit of the admin money and account writes (phase 9 S6) on top of useAdminE2e. Users that
// get ledger entries are made here and never deleted (the ledger is append-only and restricts
// its users); cards are retired at the end; every notify job the file queued is removed.

const API = '/api/v1/admin';
const MINUTE = 60_000;

export interface Session {
  readonly admin: AdminUser;
  readonly cookie: string;
}

export function adminWriteKit(t: AdminE2e) {
  const cardIds: string[] = [];
  let notifyBefore = new Set<string>();
  const notify = () => t.app().get<Queue>(getQueueToken(QUEUES.NOTIFY));
  const outbox = () => t.app().get<Queue>(getQueueToken(QUEUES.TG_OUTBOX));

  const adminIds: string[] = [];
  const challenges = new Set<string>();

  beforeAll(async () => {
    notifyBefore = await queueJobIds(notify());
  });

  // In the harness's afterAll, before the app closes: cards retired, notify jobs, code challenges
  // and their outbox jobs, and the daily code counters of this file's admins removed.
  t.onClose(async () => {
    await t.db().topupCard.updateMany({
      where: { id: { in: cardIds }, status: { not: 'RETIRED' } },
      data: { status: 'RETIRED', retiredAt: new Date() },
    });
    await removeJobsAddedSince(notify(), notifyBefore);
    for (const id of challenges) await outbox().remove(adminOtpJobId(id));
    const days = [tashkentDayKey(new Date()), tashkentDayKey(t.clock.now())];
    const keys = [
      ...[...challenges].map(adminOtpKey),
      ...adminIds.flatMap((id) => days.map((day) => adminOtpQuotaKey(id, day))),
    ];
    if (keys.length > 0)
      await t
        .app()
        .get(RedisService)
        .client.del(...keys);
  });

  const session = async (role: AdminUser['role']): Promise<Session> => {
    const admin = await t.newAdmin(role);
    adminIds.push(admin.id);
    return { admin, cookie: (await t.login(admin)).cookie };
  };

  /** A Mini App bearer of the user (no web session: the guard reads the user on each request). */
  const miniApp = (userId: string): Record<string, string> => {
    const iat = Math.floor(Date.now() / 1000);
    const token = t
      .app()
      .get(TokenCodec)
      .sign({ typ: 'tg', sub: userId, iat, exp: iat + 3600 });
    return { authorization: `Bearer ${token}` };
  };

  /** A user with a wallet that may get ledger rows (kept: the ledger restricts deletes). */
  const user = async (): Promise<string> => {
    const row = await t.db().user.create({
      data: {
        telegramId: BigInt(nextTestTelegramId()),
        firstName: 'Admin e2e',
        referralCode: `adm${randomBytes(6).toString('hex')}`,
        wallet: { create: {} },
      },
      select: { id: true },
    });
    return row.id;
  };

  const post = (
    who: Session,
    path: string,
    body: object,
    key: string | null = randomUUID(),
  ): Promise<Res> =>
    t.request(
      'POST',
      `${API}/${path}`,
      t.spa({ cookie: who.cookie, ...(key === null ? {} : { 'idempotency-key': key }) }),
      undefined,
      body,
    );

  /** `POST /admin/confirmations`, then the code read from the admin's bot message. */
  const code = async (who: Session, body: AdminConfirmationBody) => {
    const res = await post(who, 'confirmations', body, null);
    if (res.statusCode !== 201)
      throw new Error(`confirmation ${String(res.statusCode)} ${res.body}`);
    const { challengeId } = res.json<{ data: { challengeId: string } }>().data;
    challenges.add(challengeId);
    const job = await outbox().getJob(adminOtpJobId(challengeId));
    const data: unknown = job?.data;
    const text = typeof data === 'object' && data !== null && 'text' in data ? data.text : '';
    await job?.remove();
    return { challengeId, code: codeIn(typeof text === 'string' ? text : '') };
  };

  const balance = async (userId: string): Promise<bigint> => {
    const sum = await t.db().ledgerEntry.aggregate({
      where: { userId },
      _sum: { amountTiyin: true },
    });
    return sum._sum.amountTiyin ?? 0n;
  };

  /** A confirmed provider-agnostic top-up with its TOPUP entry. */
  const payment = async (userId: string, amountTiyin: bigint): Promise<string> => {
    const tag = randomBytes(6).toString('hex');
    const intent = await t.db().paymentIntent.create({
      data: {
        userId,
        provider: 'CLICK',
        amountTiyin,
        status: 'PENDING',
        purpose: 'TOPUP',
        idempotencyKey: `adm_${tag}`,
        requestHash: `adm_${tag}`,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    const row = await t.db().payment.create({
      data: {
        intentId: intent.id,
        userId,
        provider: 'CLICK',
        providerTxnId: `adm_${tag}`,
        amountTiyin,
        status: 'CONFIRMED',
        raw: {},
        confirmedAt: new Date(),
      },
    });
    await t.db().ledgerEntry.create({
      data: { userId, kind: 'TOPUP', amountTiyin, refType: 'PAYMENT', refId: row.id },
    });
    return row.id;
  };

  const card = async (): Promise<TopupCard> => {
    for (let attempt = 0; ; attempt += 1) {
      const pan = syntheticPan();
      try {
        const row = await t.db().topupCard.create({
          data: {
            bank: 'HUMO',
            pan,
            last4: pan.slice(-4),
            holderName: TEST_HOLDER,
            status: 'ACTIVE',
            receiveLimitTiyin: 900_000_000_000_000n,
            verifyAmountTiyin: 100_100n,
            verifiedAt: new Date(Date.now() - 10 * 24 * 60 * MINUTE),
          },
        });
        cardIds.push(row.id);
        return row;
      } catch (error) {
        if (attempt === 9) throw error;
      }
    }
  };

  /** A NO_MATCH review of a received amount on its own card (the CLI e2e's shape). */
  const review = async (amountTiyin = 5_000_000n + BigInt(randomInt(1, 999)) * 100n) => {
    const onCard = await card();
    const tgDate = new Date(Date.now() - MINUTE);
    const message = await t.db().bankMessage.create({
      data: {
        source: 'HUMO_BOT',
        senderId: 777_000_000_000n + BigInt(randomInt(1_000_000)),
        tgMessageId: BigInt(`0x${randomBytes(6).toString('hex')}`),
        tgDate,
        textSha256: randomBytes(32).toString('hex'),
        parseStatus: 'PARSED',
        parserVersion: 1,
        direction: 'CREDIT',
        amountTiyin,
        balanceAfterTiyin: amountTiyin + 7n,
        last4: onCard.last4,
        bankTxnAt: tgDate,
        cardId: onCard.id,
        rawText: {
          create: { text: 'synthetic bank text', purgeAfter: new Date(Date.now() + 86_400_000) },
        },
      },
    });
    const row = await t.db().paymentReview.create({
      data: { bankMessageId: message.id, kind: 'NO_MATCH', cardId: onCard.id },
      select: { id: true },
    });
    return { reviewId: row.id, amountTiyin, messageId: message.id };
  };

  /** The owner alert jobs queued for an audit row (`adminAction`) or a user (`walletFrozen`). */
  const alerts = async (alert: string, refId: string): Promise<number> => {
    const jobs = await notify().getJobs(['waiting', 'delayed', 'prioritized', 'completed']);
    return jobs.filter((job) => {
      const data: unknown = job.data;
      return (
        typeof data === 'object' &&
        data !== null &&
        'alert' in data &&
        data.alert === alert &&
        'refId' in data &&
        typeof data.refId === 'string' &&
        data.refId.startsWith(refId)
      );
    }).length;
  };

  return { session, miniApp, user, post, code, balance, payment, card, review, alerts };
}

/** The `data` of a 2xx envelope. */
export function dataOf<T>(res: Res): T {
  return res.json<{ data: T }>().data;
}

/** `details.fields` of a refusal (or `details` when it has no fields). */
export function errorOf(res: Res): { code: string; details: unknown } {
  const body = res.json<{ error: { code: string; details?: { fields?: unknown } } }>().error;
  return { code: body.code, details: body.details?.fields ?? body.details };
}

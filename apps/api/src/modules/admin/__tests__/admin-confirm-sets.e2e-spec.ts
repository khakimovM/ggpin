import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import {
  AdminAdjustPreviewResponseSchema,
  QUEUES,
  tashkentDayKey,
  type AdminConfirmationBody,
} from '@repo/shared';
import type { Queue } from 'bullmq';
import { RedisService } from '../../../infra/redis/redis.service';
import { createP2pPayment, retireCards } from '../../wallet/__tests__/wallet-p2p-fixture';
import { adminOtpJobId, adminOtpQuotaKey } from '../confirm/admin-otp.keys';
import { useAdminE2e } from './admin-e2e.harness';
import { purgeFixtureCatalogAround } from './admin-fixture-purge';
import { NOT_FIXTURE_ENTRY, orderOf, setOrderStatus } from './admin-open-orders.fixtures';
import { adminWriteKit, dataOf, errorOf, type Session } from './admin-write.e2e-kit';

// Phase 9 S7a-fix (owner decision 2026-11-22, docs/04 «Tasdiq kodi»): `POST /admin/confirmations`
// for `users.adjustWallet` issues NO code while the recent auto top-ups' or the open orders' set
// is not confirmed or already stale. It answers the action's own `400 fields[{ path: "user" }]`
// at once: no code made, the daily code count not spent, nothing queued for Telegram, no money.
const t = useAdminE2e();
purgeFixtureCatalogAround(t, 'oo-');
const kit = adminWriteKit(t);
const API = '/api/v1/admin';

const cards: string[] = [];
t.onClose(() => retireCards(t.db(), cards));

const outbox = () => t.app().get<Queue>(getQueueToken(QUEUES.TG_OUTBOX));

/** The admin's daily code count (the issuer's own key, by the app clock's Tashkent day). */
async function codesToday(owner: Session): Promise<number> {
  const key = adminOtpQuotaKey(owner.admin.id, tashkentDayKey(t.clock.now()));
  const value = await t.app().get(RedisService).client.get(key);
  return value === null ? 0 : Number(value);
}

/**
 * Telegram outbox jobs addressed to the admin's chat (each session is a fresh Telegram id). The
 * session's own login message is there already, so callers compare with a count taken before.
 */
async function messagesTo(owner: Session): Promise<number> {
  const chatId = owner.admin.telegramId.toString();
  const jobs = await outbox().getJobs(['waiting', 'delayed', 'prioritized', 'active']);
  return jobs.filter((job) => {
    const data: unknown = job.data;
    return typeof data === 'object' && data !== null && 'chatId' in data && data.chatId === chatId;
  }).length;
}

async function previewSets(owner: Session, userId: string, amount: string) {
  const res = await t.request(
    'GET',
    `${API}/users/${userId}/adjust-preview?amountTiyin=${amount}`,
    t.spa({ cookie: owner.cookie }),
  );
  const view = AdminAdjustPreviewResponseSchema.parse(dataOf(res));
  return { override: view.confirmOverrideSet, open: view.confirmOpenOrdersSet };
}

type Sets = Pick<
  Extract<AdminConfirmationBody, { action: 'users.adjustWallet' }>,
  'confirmOverrideSet' | 'confirmOpenOrdersSet'
>;

const ask = (owner: Session, userId: string, amount: string, sets: Sets = {}) =>
  kit.post(
    owner,
    'confirmations',
    {
      action: 'users.adjustWallet',
      targetId: userId,
      amountTiyin: amount,
      ...sets,
      idempotencyKey: randomUUID(),
    },
    null,
  );

/** Refused at once with the action's own field error; nothing issued, sent or written. */
async function expectRefused(
  owner: Session,
  userId: string,
  sent: () => Promise<Awaited<ReturnType<typeof ask>>>,
  code: 'OPEN_ORDERS' | 'RECENT_AUTO_TOPUP',
): Promise<void> {
  const messagesBefore = await messagesTo(owner);
  const res = await sent();
  expect(res.statusCode).toBe(400);
  expect(errorOf(res)).toMatchObject({
    code: 'VALIDATION_ERROR',
    details: [{ path: 'user', code }],
  });
  expect(await codesToday(owner)).toBe(0);
  expect(await messagesTo(owner)).toBe(messagesBefore);
  expect(
    await t.db().ledgerEntry.count({ where: { userId, kind: 'ADJUSTMENT', ...NOT_FIXTURE_ENTRY } }),
  ).toBe(0);
}

describe('confirmations: unconfirmed or stale sets get no code (S7a-fix)', () => {
  it('open orders without the set, or with a stale one: 400 OPEN_ORDERS, no code', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    await orderOf(t.db(), userId, 'HELD');
    await expectRefused(owner, userId, () => ask(owner, userId, '10000'), 'OPEN_ORDERS');

    const { open: stale } = await previewSets(owner, userId, '10000');
    await orderOf(t.db(), userId, 'QUEUED');
    const withStale = { confirmOpenOrdersSet: stale ?? '' };
    await expectRefused(owner, userId, () => ask(owner, userId, '10000', withStale), 'OPEN_ORDERS');
  });

  it('CR #2: the confirmed HELD order was auto-refunded meanwhile: 400 OPEN_ORDERS, no code', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    const order = await orderOf(t.db(), userId, 'HELD');
    const { open } = await previewSets(owner, userId, '10000');
    expect(open).toMatch(/^[0-9a-f]{12}$/);
    await setOrderStatus(t.db(), order.id, 'REFUNDED'); // nothing is open any more
    const seen = { confirmOpenOrdersSet: open ?? '' };
    await expectRefused(owner, userId, () => ask(owner, userId, '10000', seen), 'OPEN_ORDERS');
  });

  it('recent automatic top-ups without the override: 400 RECENT_AUTO_TOPUP, no code', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    await createP2pPayment(
      t.db(),
      (paymentId, amountTiyin) =>
        t.db().ledgerEntry.create({
          data: { userId, kind: 'TOPUP', amountTiyin, refType: 'PAYMENT', refId: paymentId },
        }),
      cards,
      userId,
      { baseTiyin: 2_000_000n },
    );
    await expectRefused(owner, userId, () => ask(owner, userId, '10000'), 'RECENT_AUTO_TOPUP');
  });

  it('with the sets the preview gave the code is issued, counted and queued (the measures work)', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    await orderOf(t.db(), userId, 'NEEDS_REVIEW');
    const { open } = await previewSets(owner, userId, '10000');
    const before = await codesToday(owner);
    const messagesBefore = await messagesTo(owner);
    const res = await ask(owner, userId, '10000', { confirmOpenOrdersSet: open ?? '' });
    expect(res.statusCode).toBe(201);
    expect(await codesToday(owner)).toBe(before + 1);
    // CR re-review m1: the outbox count is a live measure, not one that can only stay flat.
    expect(await messagesTo(owner)).toBe(messagesBefore + 1);
    const { challengeId } = res.json<{ data: { challengeId: string } }>().data;
    await (await outbox().getJob(adminOtpJobId(challengeId)))?.remove();
  });

  it('a debit is not held back by open orders: the code rule alone decides', async () => {
    const owner = await kit.session('OWNER');
    const userId = await kit.user();
    await orderOf(t.db(), userId, 'HELD');
    const res = await ask(owner, userId, '-5');
    expect(errorOf(res).details).toEqual([{ path: 'action', code: 'OTP_NOT_REQUIRED' }]);
  });
});

import { randomBytes } from 'node:crypto';
import type { AdminKeyedWritePermission } from '@repo/shared';
import { nextTestTelegramId } from '../../../config/__tests__/test-telegram-id';
import type { AdminE2e } from './admin-e2e.api';
import { packageBody, type catalogKit } from './admin-catalog-write.e2e-kit';
import type { VoidTargets } from './admin-write-void.e2e-table';
import type { adminWriteKit, Session } from './admin-write.e2e-kit';

// 9-B SA-1 fix round (CR #1, SA-9B1-1): for every row of the void table, a request that SUCCEEDS
// (fresh targets in the state the action needs, its code when it needs one), so the table can
// prove (a) its audit row id is adminAuditIdFor(admin, key) — the void answers APPLIED — and
// (b) a tombstone committed while it waits on that id makes it lose: 409, nothing written.

export interface LiveCall {
  /** The ids this call acts on; the rest of the snapshot uses the suite's base targets. */
  readonly targets: Partial<VoidTargets>;
  readonly body: object;
  /** Route-specific state beyond the target rows (all products' order, a new admin row). */
  readonly extra?: () => Promise<unknown>;
  /** Clean-up the harness cannot know about (a panel-created admin). */
  readonly after?: () => Promise<void>;
}

export type LiveBuilder = (who: Session) => Promise<LiveCall>;

type WriteKit = ReturnType<typeof adminWriteKit>;
type CatalogKit = ReturnType<typeof catalogKit>;

const REASON = 'checked by the void table';
const tag = () => randomBytes(4).toString('hex');

/** Call once per suite file, after the kits (it registers a clean-up for the products' order). */
export function voidLiveCalls(
  t: AdminE2e,
  kit: WriteKit,
  catalog: CatalogKit,
): Partial<Record<AdminKeyedWritePermission, LiveBuilder>> {
  const db = () => t.db();
  // The reorder rows change every product's sort on the shared test database: put it back.
  let originalSorts: { id: string; sort: number }[] = [];
  beforeAll(async () => {
    originalSorts = await db().product.findMany({ select: { id: true, sort: true } });
  });
  t.onClose(async () => {
    const client = db();
    await client.$transaction(
      originalSorts.map((row) =>
        client.product.updateMany({ where: { id: row.id }, data: { sort: row.sort } }),
      ),
    );
  });

  const user = async (change: { isBlocked?: boolean; purchaseFrozen?: boolean } = {}) => {
    const userId = await kit.user();
    if (Object.keys(change).length > 0)
      await db().user.update({ where: { id: userId }, data: change });
    return userId;
  };
  const userCall =
    (change: { isBlocked?: boolean; purchaseFrozen?: boolean } = {}): LiveBuilder =>
    async () => ({ targets: { userId: await user(change) }, body: { reason: REASON } });
  const cardCall =
    (body: object): LiveBuilder =>
    async () => ({
      targets: { cardId: (await kit.card()).id },
      body,
    });
  const catalogCall =
    (body: () => object): LiveBuilder =>
    async () => ({
      targets: await catalog.product(),
      body: body(),
    });
  const otherAdmin = async () => {
    const admin = await t.newAdmin('OPERATOR');
    await t.login(admin);
    const session = await db().adminSession.findFirstOrThrow({ where: { adminId: admin.id } });
    return { adminId: admin.id, sessionId: session.id };
  };

  const calls: Partial<Record<AdminKeyedWritePermission, LiveBuilder>> = {
    'users.note': async () => ({ targets: { userId: await user() }, body: { text: 'void live' } }),
    'users.block': userCall(),
    'users.unblock': userCall({ isBlocked: true }),
    'users.freeze': userCall(),
    'users.unfreeze': userCall({ purchaseFrozen: true }),
    'users.sessionsRevoke': userCall(),
    'users.adjustWallet': async () => {
      const userId = await user();
      await kit.payment(userId, 2_000_000n);
      return { targets: { userId }, body: { amountTiyin: '-500000', reason: REASON } };
    },
    'payments.reviewCredit': async (who) => {
      const userId = await user();
      const { reviewId, amountTiyin } = await kit.review();
      const amount = amountTiyin.toString();
      const otp = await kit.code(who, {
        action: 'payments.reviewCredit',
        targetId: reviewId,
        amountTiyin: amount,
        userId,
        confirmOverride: false,
        bankVerified: false,
      });
      return {
        targets: { userId, reviewId },
        body: { userId, reason: REASON, confirmAmountTiyin: amount, otp },
      };
    },
    'payments.reverse': async () => {
      const userId = await user();
      const paymentId = await kit.payment(userId, 300_000n);
      return { targets: { userId, paymentId }, body: { reason: REASON } };
    },
    'cards.pause': cardCall({ reason: REASON }),
    'cards.resume': async (who) => {
      const card = await kit.card();
      const paused = await kit.post(who, `payments/cards/${card.id}/pause`, { reason: REASON });
      if (paused.statusCode !== 200) throw new Error(`pause ${String(paused.statusCode)}`);
      return { targets: { cardId: card.id }, body: { reason: REASON } };
    },
    // Raising a limit needs no code (lowering does): start the card low.
    'cards.limit': async () => {
      const card = await kit.card();
      await db().topupCard.update({
        where: { id: card.id },
        data: { receiveLimitTiyin: 100_000_000n },
      });
      return {
        targets: { cardId: card.id },
        body: { receiveLimitTiyin: '200000000', reason: REASON },
      };
    },
    'cards.retire': async (who) => {
      const card = await kit.card();
      const otp = await kit.code(who, {
        action: 'cards.retire',
        targetId: card.id,
        emergency: true,
      });
      return { targets: { cardId: card.id }, body: { reason: REASON, emergency: true, otp } };
    },
    'catalog.categoryUpdate': catalogCall(() => ({ nameUz: `ACW kat yangi ${tag()}` })),
    'catalog.productUpdate': catalogCall(() => ({ nameUz: `ACW yangi ${tag()}` })),
    // The full set in the reverse of the current order: always a change.
    'catalog.productReorder': async () => {
      const rows = await catalog.product();
      const ids = (
        await db().product.findMany({
          select: { id: true },
          orderBy: [{ sort: 'desc' }, { id: 'desc' }],
        })
      ).map((row) => row.id);
      const extra = () =>
        db().product.findMany({ select: { id: true, sort: true }, orderBy: { id: 'asc' } });
      return { targets: rows, body: { productIds: ids }, extra };
    },
    'catalog.skuCreate': catalogCall(() => packageBody()),
    'catalog.skuUpdate': catalogCall(() => ({ labelUz: `ACW paket ${tag()}` })),
    'catalog.routeUpdate': catalogCall(() => ({ priority: 7 })),
    'admins.create': async (who) => {
      const telegramId = String(nextTestTelegramId());
      const asked = { telegramId, name: 'Void live', role: 'SUPPORT' } as const;
      const otp = await kit.code(who, { action: 'admins.create', ...asked });
      const row = () => db().adminUser.findUnique({ where: { telegramId: BigInt(telegramId) } });
      return {
        targets: {},
        body: { ...asked, reason: REASON, otp },
        extra: row,
        after: async () => {
          const made = await row();
          if (made !== null) t.trackAdmin(made);
        },
      };
    },
    'admins.update': async (who) => {
      const { adminId } = await otherAdmin();
      const otp = await kit.code(who, {
        action: 'admins.update',
        targetId: adminId,
        role: 'SUPPORT',
      });
      return { targets: { adminId }, body: { role: 'SUPPORT', reason: REASON, otp } };
    },
    'admins.sessionsRevoke': async (who) => {
      const targets = await otherAdmin();
      const otp = await kit.code(who, {
        action: 'admins.sessionsRevoke',
        targetId: targets.adminId,
      });
      return { targets, body: { reason: REASON, otp } };
    },
    'sessions.revoke': async (who) => {
      const targets = await otherAdmin();
      const otp = await kit.code(who, { action: 'sessions.revoke', targetId: targets.sessionId });
      return { targets, body: { reason: REASON, otp } };
    },
  };
  return calls;
}

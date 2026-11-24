import { randomUUID } from 'node:crypto';
import { ADMIN_KEYED_WRITE_PERMISSIONS, type AdminKeyedWritePermission } from '@repo/shared';
import { RedisService } from '../../../infra/redis/redis.service';
import { adminWriteLimitKey } from '../common/admin-throttle';
import { adminAuditIdFor } from '../write/admin-write-key';
import { catalogKit } from './admin-catalog-write.e2e-kit';
import { useAdminE2e } from './admin-e2e.harness';
import { heldTransaction, waitForLockWaiter } from './admin-e2e.locks';
import { voidLiveCalls, type LiveCall } from './admin-write-void.e2e-live';
import {
  VOID_ROUTE_CASES,
  pathOf,
  targetOf,
  type VoidCase,
  type VoidTargets,
} from './admin-write-void.e2e-table';
import { adminWriteKit, dataOf, errorOf, type Session } from './admin-write.e2e-kit';

// 9-B SA-1, docs/04 «Idempotency-Key» (d)/(e), on EVERY keyed route (admin-write-void-routes
// .spec.ts proves the table complete), three columns:
// 1. void first, then the same key and body -> 409 and nothing written (the runner's first look);
// 2. the request commits, then the void -> APPLIED with auditId === adminAuditIdFor(admin, key):
//    the route writes its audit row under the key's id (CR #1);
// 3. late commit: a tombstone inserted and held uncommitted in another transaction, the request
//    sent and seen waiting on that id, the tombstone committed -> the request loses on the primary
//    key: 409, its whole transaction rolled back (SA-9B1-1).
const t = useAdminE2e();
const kit = adminWriteKit(t);
const catalog = catalogKit(t);
const live = voidLiveCalls(t, kit, catalog);
const AUDIT_INSERT = '%INSERT INTO "public"."AuditLog"%';

let owner: Session;
let ownerSessionId = '';
let base: VoidTargets;

const json = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

/** Every row a table request could touch, and the counts it could grow. */
async function snapshot(targets: VoidTargets, actorId: string, extra?: LiveCall['extra']) {
  const db = t.db();
  return json({
    user: await db.user.findUnique({ where: { id: targets.userId } }),
    ledger: await db.ledgerEntry.findMany({
      where: { userId: targets.userId },
      orderBy: { id: 'asc' },
    }),
    webSessions: await db.webSession.findMany({ where: { userId: targets.userId } }),
    payment: await db.payment.findUnique({ where: { id: targets.paymentId } }),
    payments: await db.payment.count({ where: { userId: targets.userId } }),
    review: await db.paymentReview.findUnique({ where: { id: targets.reviewId } }),
    card: await db.topupCard.findUnique({ where: { id: targets.cardId } }),
    category: await db.category.findUnique({ where: { id: targets.categoryId } }),
    product: await db.product.findUnique({ where: { id: targets.productId } }),
    skus: await db.sku.findMany({
      where: { productId: targets.productId },
      orderBy: { id: 'asc' },
    }),
    route: await db.productRoute.findUnique({ where: { id: targets.routeId } }),
    admin: await db.adminUser.findUnique({ where: { id: targets.adminId } }),
    adminSessions: await db.adminSession.findMany({
      where: { adminId: targets.adminId },
      select: { id: true, revokedAt: true },
    }),
    audits: await db.auditLog.count({
      where: { actorId, action: { not: 'IDEMPOTENCY_VOID' } },
    }),
    extra: extra === undefined ? null : await extra(),
  });
}

beforeAll(async () => {
  owner = await kit.session('OWNER');
  const session = await t.db().adminSession.findFirstOrThrow({
    where: { adminId: owner.admin.id },
    orderBy: { createdAt: 'desc' },
  });
  ownerSessionId = session.id;
  const userId = await kit.user();
  const paymentId = await kit.payment(userId, 900_000n);
  const { reviewId } = await kit.review();
  const card = await kit.card();
  const rows = await catalog.product();
  const other = await t.newAdmin('OPERATOR');
  await t.login(other);
  const otherSession = await t.db().adminSession.findFirstOrThrow({ where: { adminId: other.id } });
  base = {
    userId,
    paymentId,
    reviewId,
    cardId: card.id,
    ...rows,
    adminId: other.id,
    sessionId: otherSession.id,
  };
});

const send = (who: Session, row: VoidCase, targets: VoidTargets, body: object, key: string) =>
  t.request(
    row.method,
    `/api/v1/admin/${pathOf(row, targets)}`,
    t.spa({ cookie: who.cookie, 'idempotency-key': key }),
    undefined,
    body,
  );

const callVoid = (who: Session, permission: string, targetId: string, key: string) =>
  kit.post(who, 'write-keys/void', { idempotencyKey: key, action: permission, targetId }, null);

/** A fresh OWNER session and a live call: own write budget, own codeless budget, its code. */
async function prepare(permission: AdminKeyedWritePermission) {
  const builder = live[permission];
  if (builder === undefined) throw new Error(`no live call for ${permission}`);
  const who = await kit.session('OWNER');
  const call = await builder(who);
  return { who, call, targets: { ...base, ...call.targets } };
}

const served = ADMIN_KEYED_WRITE_PERMISSIONS.flatMap((permission) => {
  const row = VOID_ROUTE_CASES[permission];
  return row === undefined ? [] : [[permission, row] as const];
});

describe('a voided key on every keyed admin route', () => {
  it('the table covers the served routes (23 today), each with a live call', () => {
    expect(served.length).toBe(Object.keys(VOID_ROUTE_CASES).length);
    expect(served.length).toBeGreaterThanOrEqual(23);
    expect(Object.keys(live).sort()).toEqual(served.map(([permission]) => permission).sort());
  });

  it.each(served)(
    '%s: void, then the same key and body -> 409, nothing written',
    async (permission: AdminKeyedWritePermission, row: VoidCase) => {
      // Two writes per row on one session: reset its write budget (30/min) between rows.
      await t.app().get(RedisService).client.del(adminWriteLimitKey(ownerSessionId));
      const key = randomUUID();
      const voided = await callVoid(owner, permission, targetOf(row, base), key);
      expect(voided.statusCode).toBe(200);
      const auditId = adminAuditIdFor(owner.admin.id, key);
      expect(dataOf(voided)).toMatchObject({ status: 'VOIDED', auditId });
      const before = await snapshot(base, owner.admin.id);

      const res = await send(owner, row, base, row.body(base), key);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await snapshot(base, owner.admin.id)).toBe(before);
      const underKey = await t.db().auditLog.findUniqueOrThrow({ where: { id: auditId } });
      expect(underKey).toMatchObject({ action: 'IDEMPOTENCY_VOID', actorId: owner.admin.id });
      expect(underKey.after).toEqual({
        voidedAction: permission,
        adminRole: 'OWNER',
        sessionId: ownerSessionId,
      });
    },
  );

  it.each(served)(
    '%s: the request commits, then the void -> APPLIED under the key’s audit id',
    async (permission: AdminKeyedWritePermission, row: VoidCase) => {
      const { who, call, targets } = await prepare(permission);
      const key = randomUUID();
      const auditId = adminAuditIdFor(who.admin.id, key);
      const res = await send(who, row, targets, call.body, key);
      await call.after?.();
      expect(res.statusCode).toBe(200);
      expect(dataOf(res)).toMatchObject({ applied: true });
      const answer = dataOf<{ auditId?: unknown }>(res);
      if ('auditId' in answer) expect(answer.auditId).toBe(auditId);

      const voided = await callVoid(who, permission, targetOf(row, targets), key);
      expect(dataOf(voided)).toMatchObject({ status: 'APPLIED', auditId });
      const written = await t.db().auditLog.findUniqueOrThrow({ where: { id: auditId } });
      expect(written.action).not.toBe('IDEMPOTENCY_VOID');
      expect(written.actorId).toBe(who.admin.id);
    },
  );

  it.each(served)(
    '%s: a tombstone committed while the request waits on its id -> 409, rolled back',
    async (permission: AdminKeyedWritePermission, row: VoidCase) => {
      const { who, call, targets } = await prepare(permission);
      const key = randomUUID();
      const auditId = adminAuditIdFor(who.admin.id, key);
      const before = await snapshot(targets, who.admin.id, call.extra);
      const holder = await heldTransaction(t.db(), (tx) =>
        tx.auditLog.create({
          data: {
            id: auditId,
            actorType: 'ADMIN',
            actorId: who.admin.id,
            action: 'IDEMPOTENCY_VOID',
            targetType: 'VoidTable',
            targetId: targetOf(row, targets),
            after: { voidedAction: permission },
          },
        }),
      );
      let settled = false;
      const sending = send(who, row, targets, call.body, key).finally(() => {
        settled = true;
      });
      const waited = await waitForLockWaiter(t.db(), AUDIT_INSERT, () => settled);
      await holder.commit();
      const res = await sending;
      await call.after?.();

      expect(waited).toBe(true);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await snapshot(targets, who.admin.id, call.extra)).toBe(before);
      const underKey = await t.db().auditLog.findUniqueOrThrow({ where: { id: auditId } });
      expect(underKey.action).toBe('IDEMPOTENCY_VOID');
    },
  );
});

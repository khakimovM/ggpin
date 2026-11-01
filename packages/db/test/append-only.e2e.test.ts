import { describe, expect, it } from 'vitest';
import { db } from './client';
import { createOrder, createUser } from './factories';

// The trigger raises the project SQLSTATE GG001 (migration 20261031130000). Unlike 23001, which the
// pg adapter turns into a foreign-key-style error without the text, an unknown code keeps both, so
// the client path proves the write was rejected BY THE TRIGGER, not by some other constraint.
async function expectRejected(promise: Promise<unknown>): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  const text = String(error instanceof Error ? error.message : error);
  expect(text).toContain('is append-only');
  expect(text).toContain('GG001');
}

async function expectRawAppendOnly(sql: string, table: string): Promise<void> {
  const error: unknown = await db.$executeRawUnsafe(sql).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, sql).toBeInstanceOf(Error);
  expect(String((error as Error).message)).toContain(`${table} is append-only`);
}

describe('append-only tables (DB triggers)', () => {
  it('LedgerEntry: UPDATE and DELETE are rejected, the row is unchanged', async () => {
    const user = await createUser();
    const entry = await db.ledgerEntry.create({
      data: { userId: user.id, kind: 'TOPUP', amountTiyin: 500n, refType: 'PAYMENT', refId: 'p1' },
    });
    await expectRejected(
      db.ledgerEntry.update({ where: { id: entry.id }, data: { amountTiyin: 999n } }),
    );
    await expectRejected(db.ledgerEntry.delete({ where: { id: entry.id } }));
    await expectRejected(db.ledgerEntry.deleteMany({}));
    const after = await db.ledgerEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.amountTiyin).toBe(500n);
    expect(await db.ledgerEntry.count()).toBe(1);
  });

  it('CoinEntry: UPDATE and DELETE are rejected, the row is unchanged', async () => {
    const user = await createUser();
    const entry = await db.coinEntry.create({
      data: { userId: user.id, kind: 'EARN', coins: 10n, refType: 'ORDER', refId: 'o1' },
    });
    await expectRejected(db.coinEntry.update({ where: { id: entry.id }, data: { coins: 99n } }));
    await expectRejected(db.coinEntry.delete({ where: { id: entry.id } }));
    expect((await db.coinEntry.findUniqueOrThrow({ where: { id: entry.id } })).coins).toBe(10n);
  });

  it('OrderEvent: UPDATE and DELETE are rejected, the row is unchanged', async () => {
    const order = await createOrder(await createUser());
    const event = await db.orderEvent.create({
      data: { orderId: order.id, to: 'PAID', actor: 'SYSTEM' },
    });
    await expectRejected(
      db.orderEvent.update({ where: { id: event.id }, data: { note: 'rewritten' } }),
    );
    await expectRejected(db.orderEvent.delete({ where: { id: event.id } }));
    expect((await db.orderEvent.findUniqueOrThrow({ where: { id: event.id } })).note).toBeNull();
  });

  it('AuditLog: UPDATE and DELETE are rejected, the row is unchanged', async () => {
    const log = await db.auditLog.create({
      data: { actorType: 'SYSTEM', action: 'TEST', targetType: 'ORDER', targetId: 'o1' },
    });
    await expectRejected(
      db.auditLog.update({ where: { id: log.id }, data: { reason: 'rewritten' } }),
    );
    await expectRejected(db.auditLog.delete({ where: { id: log.id } }));
    expect((await db.auditLog.findUniqueOrThrow({ where: { id: log.id } })).reason).toBeNull();
  });

  it('raw SQL UPDATE/DELETE on every protected table raises the "append-only" message', async () => {
    const user = await createUser();
    const order = await createOrder(user);
    await db.ledgerEntry.create({
      data: { userId: user.id, kind: 'TOPUP', amountTiyin: 1n, refType: 'PAYMENT', refId: 'raw' },
    });
    await db.coinEntry.create({
      data: { userId: user.id, kind: 'EARN', coins: 1n, refType: 'ORDER', refId: 'raw' },
    });
    await db.orderEvent.create({ data: { orderId: order.id, to: 'PAID', actor: 'SYSTEM' } });
    await db.auditLog.create({
      data: { actorType: 'SYSTEM', action: 'TEST', targetType: 'ORDER', targetId: 'raw' },
    });
    await expectRawAppendOnly(`UPDATE "LedgerEntry" SET "refType" = 'X'`, 'LedgerEntry');
    await expectRawAppendOnly(`DELETE FROM "LedgerEntry"`, 'LedgerEntry');
    await expectRawAppendOnly(`UPDATE "CoinEntry" SET "refType" = 'X'`, 'CoinEntry');
    await expectRawAppendOnly(`DELETE FROM "CoinEntry"`, 'CoinEntry');
    await expectRawAppendOnly(`UPDATE "OrderEvent" SET "note" = 'X'`, 'OrderEvent');
    await expectRawAppendOnly(`DELETE FROM "OrderEvent"`, 'OrderEvent');
    await expectRawAppendOnly(`UPDATE "AuditLog" SET "reason" = 'X'`, 'AuditLog');
    await expectRawAppendOnly(`DELETE FROM "AuditLog"`, 'AuditLog');
  });

  it('TRUNCATE still works (test cleanup relies on it; row triggers do not fire)', async () => {
    const user = await createUser();
    await db.ledgerEntry.create({
      data: { userId: user.id, kind: 'TOPUP', amountTiyin: 1n, refType: 'PAYMENT', refId: 'p2' },
    });
    await db.$executeRawUnsafe('TRUNCATE TABLE "LedgerEntry" CASCADE');
    expect(await db.ledgerEntry.count()).toBe(0);
  });
});

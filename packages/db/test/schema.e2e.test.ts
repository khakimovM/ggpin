import { ORDER_STATUSES } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { db } from './client';

// Catalog-level checks against the migrated database: what is really deployed, not just what
// schema.prisma says.
describe('migrated database', () => {
  it('OrderStatus enum in Postgres equals ORDER_STATUSES', async () => {
    const rows = await db.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'OrderStatus' ORDER BY e.enumsortorder`;
    expect(rows.map((r) => r.enumlabel)).toEqual([...ORDER_STATUSES]);
  });

  it('append-only tables have no updatedAt column', async () => {
    const rows = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'updatedAt'
        AND table_name IN ('LedgerEntry', 'CoinEntry', 'AuditLog', 'OrderEvent')`;
    expect(rows).toEqual([]);
  });

  it('mutable tables do have updatedAt', async () => {
    const rows = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'updatedAt'
        AND table_name IN ('Order', 'Payment', 'PaymentIntent', 'Quote', 'Voucher')`;
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      'Order',
      'Payment',
      'PaymentIntent',
      'Quote',
      'Voucher',
    ]);
  });

  it('no money-like column uses a floating or decimal type', async () => {
    const rows = await db.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('numeric', 'double precision', 'real')`;
    expect(rows).toEqual([]);
  });

  it('only credential tables cascade on delete; every other FK is RESTRICT', async () => {
    const rows = await db.$queryRaw<{ table_name: string; delete_rule: string }[]>`
      SELECT tc.table_name, rc.delete_rule
      FROM information_schema.referential_constraints rc
      JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name
      WHERE tc.constraint_schema = 'public'`;
    expect(rows.length).toBeGreaterThanOrEqual(33);
    const cascading = rows
      .filter((r) => r.delete_rule === 'CASCADE')
      .map((r) => r.table_name)
      .sort();
    expect(cascading).toEqual(['AdminSession', 'WebSession']);
    expect(rows.filter((r) => !['CASCADE', 'RESTRICT'].includes(r.delete_rule))).toEqual([]);
  });
});

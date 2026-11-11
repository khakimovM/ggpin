import {
  BANK_DIRECTIONS,
  BANK_FEED_SOURCES,
  BANK_OUTCOMES,
  BANK_PARSE_STATUSES,
  CARD_BANKS,
  CHAIN_STATUSES,
  INTENT_STATUSES,
  ORDER_STATUSES,
  PAYMENT_REVIEW_RESOLUTIONS,
  PAYMENT_REVIEW_STATUSES,
  REVIEW_KINDS,
  TOPUP_CARD_STATUSES,
  TOPUP_PROVIDER,
} from '@repo/shared';
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

  // What is deployed, not what schema.prisma says: a migration that forgot an ADD VALUE (or a
  // rename) passes the schema-level test but fails here. Sets, not order: Postgres keeps the
  // order values were added in, which carries no meaning for these enums.
  it.each([
    ['CardBank', CARD_BANKS],
    ['TopupCardStatus', TOPUP_CARD_STATUSES],
    ['BankFeedSource', BANK_FEED_SOURCES],
    ['BankParseStatus', BANK_PARSE_STATUSES],
    ['BankDirection', BANK_DIRECTIONS],
    ['ChainStatus', CHAIN_STATUSES],
    ['BankOutcome', BANK_OUTCOMES],
    ['PaymentReviewKind', REVIEW_KINDS],
    ['PaymentReviewStatus', PAYMENT_REVIEW_STATUSES],
    ['PaymentReviewResolution', PAYMENT_REVIEW_RESOLUTIONS],
    ['IntentStatus', INTENT_STATUSES],
  ] as const)('%s enum in Postgres equals its shared list', async (typname, list) => {
    const rows = await db.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = ${typname}`;
    expect(rows.map((r) => r.enumlabel).sort()).toEqual([...list].sort());
  });

  it('PaymentProviderCode in Postgres contains the P2P provider code', async () => {
    const rows = await db.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'PaymentProviderCode'`;
    expect(rows.map((r) => r.enumlabel)).toContain(TOPUP_PROVIDER);
  });

  it('the foreign keys added in review have their indexes', async () => {
    const rows = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
        AND indexname IN ('BankMessageOutcome_reviewId_idx', 'PaymentReview_resolvedAuditLogId_idx')`;
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      'BankMessageOutcome_reviewId_idx',
      'PaymentReview_resolvedAuditLogId_idx',
    ]);
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

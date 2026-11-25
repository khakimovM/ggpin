import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Phase 5 S9i gate (SA L-1): the automatic refund of an order — the `REFUND` ledger entry keyed
// `ORDER/<orderId>` — is written in ONE place, `refundFailedOrderWith` in
// packages/db/src/orders/order-refund.ts, behind its checks (FAILED -> REFUNDED in the same
// transaction, no live payout, the PURCHASE entry matching the order total). Every other path
// (worker run, reconciler, HELD sweep, review resolver) calls it. This spec scans the worker's
// own sources and packages/db/src (a dependency: its build hash is in this test's turbo hash);
// the API holds its side in apps/api/src/modules/orders/__tests__/refund-ledger-writer.spec.ts.
// A future REFUND writer (an admin partial refund on ADMIN_ACTION/<auditId>) is added to the
// allowlist by name, on purpose.

const WORKER_SRC = join(__dirname, '../..');
const REPO = join(WORKER_SRC, '../../..');
const DB_SRC = join(REPO, 'packages/db/src');

/** A ledger write: the one helper, the API wrapper, a Prisma create, or raw SQL. */
const LEDGER_WRITE =
  /\b(appendLedgerEntry|appendEntry)\s*\(|\bledgerEntry\s*\.\s*(create|createMany|upsert)\w*\s*\(|INSERT\s+INTO\s+(?:"?public"?\.)?"?LedgerEntry\b/i;
/**
 * A REFUND kind given to it. The scanner needs the LITERAL `kind: 'REFUND'` (or
 * `LedgerEntryKind.REFUND`) in the same file as the write: a kind passed through a variable or a
 * parameter (`kind: entry.kind`, as in appendLedgerEntry itself) is not seen. That limit is
 * accepted on purpose: every writer today spells its kind literally, a source-text scan cannot
 * follow data flow, and the review of a new money path still has to catch a computed kind.
 */
const REFUND_KIND = /\bkind\s*:\s*['"`]REFUND['"`]|\bLedgerEntryKind\s*\.\s*REFUND\b/;
/** A row written past `appendLedgerEntry` (its checks and the wallet lock). */
const DIRECT_WRITE =
  /\bledgerEntry\s*\.\s*(create|createMany|upsert)\w*\s*\(|INSERT\s+INTO\s+(?:"?public"?\.)?"?LedgerEntry\b/i;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === '__tests__' || name === 'generated' ? [] : sources(path);
    }
    return name.endsWith('.ts') && !/\.(spec|e2e-spec|test)\.ts$/.test(name) ? [path] : [];
  });
}

function matching(pattern: (source: string) => boolean): string[] {
  return [...sources(WORKER_SRC), ...sources(DB_SRC)]
    .filter((file) => pattern(readFileSync(file, 'utf8')))
    .map((file) => relative(REPO, file).split(sep).join('/'))
    .sort();
}

const refundWriter = (source: string): boolean =>
  LEDGER_WRITE.test(source) && REFUND_KIND.test(source);

describe('one writer of the ORDER REFUND ledger entry (S9i gate, SA L-1)', () => {
  it('scans what it should (control: the worker main.ts and the db order-refund.ts are read)', () => {
    const files = [...sources(WORKER_SRC), ...sources(DB_SRC)].map((file) =>
      relative(REPO, file).split(sep).join('/'),
    );
    expect(files).toEqual(
      expect.arrayContaining(['apps/worker/src/main.ts', 'packages/db/src/orders/order-refund.ts']),
    );
    expect(files.some((file) => file.includes('/generated/'))).toBe(false);
  });

  it('the patterns see a writer (control: a synthetic one, both spellings)', () => {
    expect(refundWriter("appendLedgerEntry(tx, { kind: 'REFUND', refType: 'ORDER' })")).toBe(true);
    expect(refundWriter('tx.ledgerEntry.create({ data: { kind: LedgerEntryKind.REFUND } })')).toBe(
      true,
    );
    expect(refundWriter("appendLedgerEntry(tx, { kind: 'TOPUP' })")).toBe(false);
    expect(DIRECT_WRITE.test('INSERT INTO "public"."LedgerEntry" ("kind")')).toBe(true);
  });

  it('only packages/db/src/orders/order-refund.ts writes a REFUND entry', () => {
    expect(matching(refundWriter)).toEqual(['packages/db/src/orders/order-refund.ts']);
  });

  it('only appendLedgerEntry (packages/db/src/ledger/ledger.ts) creates a ledger row', () => {
    expect(matching((source) => DIRECT_WRITE.test(source))).toEqual([
      'packages/db/src/ledger/ledger.ts',
    ]);
  });
});

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Phase 5 S9i gate (SA L-1): the `REFUND` ledger entry of an order (ORDER/<orderId>) is written
// only by `refundFailedOrderWith` in packages/db/src/orders/order-refund.ts. The API calls it
// (admin cancel and refund paths) and never writes such an entry, nor any ledger row past
// `appendLedgerEntry`, by itself. This spec scans the API's own sources (its turbo hash covers
// them); the worker spec apps/worker/src/common/__tests__/refund-ledger-writer.spec.ts scans the
// worker and packages/db/src. A future API REFUND writer (an admin partial refund on
// ADMIN_ACTION/<auditId>) is added here by name, on purpose.

const API_SRC = join(__dirname, '../../..');

/** A ledger write: the one helper, the wallet wrapper, a Prisma create, or raw SQL. */
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
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return name.endsWith('.ts') && !/\.(spec|e2e-spec|test)\.ts$/.test(name) ? [path] : [];
  });
}

function matching(pattern: (source: string) => boolean): string[] {
  return sources(API_SRC)
    .filter((file) => pattern(readFileSync(file, 'utf8')))
    .map((file) => relative(API_SRC, file).split(sep).join('/'))
    .sort();
}

const refundWriter = (source: string): boolean =>
  LEDGER_WRITE.test(source) && REFUND_KIND.test(source);

describe('the API never writes the ORDER REFUND ledger entry itself (S9i gate, SA L-1)', () => {
  it('scans the API sources (control: main.ts, and the PURCHASE writer is seen as a ledger write)', () => {
    expect(matching(() => true)).toContain('main.ts');
    expect(matching((source) => LEDGER_WRITE.test(source))).toContain(
      'modules/orders/orders.repository.ts',
    );
  });

  it('the patterns see a writer (control: a synthetic one, both spellings)', () => {
    expect(refundWriter("appendLedgerEntry(tx, { kind: 'REFUND', refType: 'ORDER' })")).toBe(true);
    expect(refundWriter("this.repo.appendEntry(tx, { kind: 'REFUND' })")).toBe(true);
    expect(refundWriter("appendLedgerEntry(tx, { kind: 'PURCHASE' })")).toBe(false);
    expect(DIRECT_WRITE.test('INSERT INTO "LedgerEntry" ("kind")')).toBe(true);
  });

  it('no API source writes a REFUND entry', () => {
    expect(matching(refundWriter)).toEqual([]);
  });

  it('no API source creates a ledger row past appendLedgerEntry', () => {
    expect(matching((source) => DIRECT_WRITE.test(source))).toEqual([]);
  });
});

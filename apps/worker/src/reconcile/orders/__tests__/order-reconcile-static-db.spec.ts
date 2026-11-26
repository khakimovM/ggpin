import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// S9i (S9e SA N-1, review R3/R4/R5): how the order reconciler may reach the database, by its text.
// - The attempt, the transfer and the order history (fulfillmentAttempt, tonTransfer, orderEvent)
//   only through a read method of a client (`.findMany(` ...), as a key of a select / where literal,
//   or named in `Pick<Tx, ...>`: no write, no `tx['tonTransfer']`, no alias (`const m = tx.x`) that
//   a write could go through. One named exception: `row.tonTransfer`, the selected relation's data
//   in readReviewPayout (a plain object, no client).
// - Exactly one tagged `$queryRaw` template (the database clock of the tick), every `$queryRaw` in
//   that form; `$queryRawUnsafe`, `$queryRawTyped` and `$executeRaw*` are refused in the main spec.
// - RELEASABLE_HELD_REASONS (D-64 (4)) is the reconciler's own list: in the worker only the release
//   policy names it (the API holds itself to the same in its own spec).

const WORKER_SRC = join(__dirname, '../../..');
const RECONCILER = join(__dirname, '..');

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') found.push(...sources(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      found.push(path);
    }
  }
  return found;
}

/** The code without comments, so a comment that names a model or a call is no finding. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const posix = (path: string, root: string): string => relative(root, path).split(sep).join('/');

const MODEL = /\b(tonTransfer|fulfillmentAttempt|orderEvent)\b/g;
const READ_CALL =
  /^\s*\.\s*(findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|aggregate|groupBy)\s*\(/;
const LITERAL_KEY = /^\s*:\s*(\{|true\b)/;
const NAMED_EXCEPTIONS: readonly string[] = ['order-reconcile.repository.ts: row.tonTransfer'];

/** Every use of a guarded model that is not a read call, a literal key or a named exception. */
function usesIn(source: string, file: string): string[] {
  const text = source.replace(/Pick<\s*Tx\s*,[^>]*>/g, 'Pick<Tx>');
  const found: string[] = [];
  for (const match of text.matchAll(MODEL)) {
    const name = match[1] ?? '';
    const before = text.slice(Math.max(0, match.index - 40), match.index);
    const after = text.slice(match.index + name.length, match.index + name.length + 40);
    const member = /\.\s*$/.test(before);
    if (member && READ_CALL.test(after)) continue;
    if (!member && /[\s{,(]$/.test(before) && LITERAL_KEY.test(after)) continue;
    const receiver = /(\w+)\s*\.\s*$/.exec(before)?.[1] ?? '';
    const use = `${file}: ${member ? `${receiver}.` : ''}${name}`;
    if (!NAMED_EXCEPTIONS.includes(use)) found.push(`${use}${after.split('\n')[0] ?? ''}`);
  }
  return found;
}

const modelUses = (path: string): string[] => usesIn(code(path), posix(path, RECONCILER));

describe('the order reconciler and the database (static, S9i)', () => {
  const files = sources(RECONCILER);

  it('R4: the attempt, transfer and order-event models are read only, never aliased', () => {
    expect(files.flatMap(modelUses)).toEqual([]);
  });

  it('R4: the check sees a write, a string key and an alias (control)', () => {
    const probe = (text: string): number => usesIn(text, 'probe.ts').length;
    expect(probe('tx.tonTransfer.update({})')).toBe(1);
    expect(probe("tx['tonTransfer'].create({})")).toBe(1);
    expect(probe('const m = tx.fulfillmentAttempt;')).toBe(1);
    expect(probe('const { orderEvent } = tx;')).toBe(1);
    expect(probe('const t = row.tonTransfer;')).toBe(1);
    expect(probe('db.orderEvent.count({}); x = { tonTransfer: { select: {} } }')).toBe(0);
    expect(probe("type D = Pick<Tx, 'tonTransfer' | 'fulfillmentAttempt'>;")).toBe(0);
  });

  it('R3: one tagged $queryRaw, in the repository, the database clock; every $queryRaw tagged', () => {
    const uses = files.flatMap((file) =>
      [...code(file).matchAll(/\$queryRaw\b/g)].map(() => posix(file, RECONCILER)),
    );
    expect(uses).toEqual(['order-reconcile.repository.ts']);
    const tagged = files.flatMap((file) => [
      ...code(file).matchAll(/\$queryRaw\s*(?:<[^`]*?>)?\s*`([^`]*)`/g),
    ]);
    expect(tagged.map((m) => (m[1] ?? '').replace(/\s+/g, ' ').trim())).toEqual([
      'SELECT floor(extract(epoch from now()) * 1000)::bigint::text AS "ms"',
    ]);
  });

  it('R5: RELEASABLE_HELD_REASONS is named in the worker only by the release policy', () => {
    const names = /\b(RELEASABLE_HELD_REASONS|ReleasableHeldReason)\b/;
    const users = sources(WORKER_SRC).filter((file) => names.test(readFileSync(file, 'utf8')));
    expect(users.map((file) => posix(file, WORKER_SRC))).toEqual([
      'reconcile/orders/held-release-policy.ts',
    ]);
  });
});

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// D-64 (1), plan §3 S9c and item 23: the order reconciler never signs, never pays, never takes the
// wallet lock, never re-broadcasts and never reads the chain itself (only TonConfirmService and
// TonLateService do); money moves only through `resolveNeedsReview` / `failAndRefundOrder`, never
// through a hand-made wallet lock, transition or ledger write. And in the whole worker only the TON
// module's outcome writer may set a transfer EXPIRED. S9e (D-64 (4)): held-writes.ts is the one
// other file allowed
// a transition and a refund, and only these two calls, checked by their text: `failAndRefundOrder`
// from HELD (HELD_EXPIRED, as the system) and `transitionOrder` HELD -> QUEUED (as the system),
// imported by name from @repo/db (no alias, no spread argument).

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

/** The code without comments, so a comment that names a forbidden call is no finding. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The HELD writer (S9e): its own narrow checks below replace the transition check for it. */
const HELD_WRITER = 'held-writes.ts';

/** Which file may call which money helper; no other file may name any (S9e fix CR F3). */
const MONEY_HELPERS =
  /\b(refundFailedOrderWith|refundFailedOrder|resolveNeedsReview|failAndRefundOrder)\b/g;
const MONEY_HELPER_OWNERS: Readonly<Record<string, readonly string[]>> = {
  'review-resolver.ts': ['resolveNeedsReview'],
  [HELD_WRITER]: ['failAndRefundOrder'],
};

/** What held-writes.ts may import from @repo/db (values and types), each by its own name. */
const HELD_WRITER_DB_IMPORTS = ['RefundOutcome', 'Tx', 'failAndRefundOrder', 'transitionOrder'];

const FORBIDDEN_IN_RECONCILER: readonly (readonly [string, RegExp])[] = [
  ['pay(', /\bpay\s*\(/],
  ['sendBoc', /sendBoc/],
  ['getTransactions(', /getTransactions\s*\(/],
  ['the wallet lock token', /TON_WALLET_LOCK/],
  ['the wallet lock key', /lock:ton-wallet/],
  ['the wallet lock class', /TonWalletLock/],
  ['the sender', /TonSenderService|TON_PAYER|TonPayer/],
  ['the signer', /TON_WALLET\b|signTransfer|signAndStore/],
  ['a hand-made EXPIRED', /EXPIRED['"]\s*}|status:\s*['"]EXPIRED['"]/],
  ['a hand-made wallet lock', /lockWallet/],
  ['a hand-made transition', /transitionOrder|applyTransition/],
  ['a hand-made ledger write', /ledgerEntry\s*\.\s*create|appendLedgerEntry/],
  ['a hand-made status write', /order\s*\.\s*(update\w*|upsert)\s*\(/],
  // S9c review CR5: no way to the chain or the outcome writes around TonConfirmService.check.
  ['the chain gateway', /TON_GATEWAY|\bTonGateway\b/],
  ['the chain reader', /TonChainReader/],
  ['the outcome writes', /TonOutcomeRepository/],
  // S9f (CR F11, audit): the late-facts step calls TonLateService only, never its writes or reader.
  ['the late writes', /TonLateRepository|writeLate\b/],
  ['the late reader', /TonLateReader/],
  ['a back door to any provider', /\bModuleRef\b/],
  // S9d: an order is queued again only through FulfillEnqueuer (decideEnqueue, jobId = orderId);
  // the reconciler never runs or settles fulfillment itself and never counts an abandon.
  ['the fulfill-order queue', /QUEUES\.FULFILL_ORDER|FULFILL_ORDER_JOB_NAME/],
  ['the fulfill-order queue by its name', /['"`]fulfill-order['"`]/],
  ['a fulfill queue injected', /InjectQueue\(\s*(QUEUES\.)?FULFILL/],
  ['a queue looked up by hand', /getQueue\(/],
  ['the fulfill run or its settle', /FulfillOrderService|settleAbandoned|FulfillSettler/],
  // S9d fix (CR F6): the count is read through ABANDON_PEEK (no bump), never the counter itself.
  ['a count of the abandon counter', /\.bump\s*\(|ABANDON_COUNTER/],
  // S9d fix (CR F6): notices only through resendHeldOrReview (it re-reads HELD / NEEDS_REVIEW).
  ['a bare replay', /\.replay\s*\(/],
  // S9e fix (CR F3): the fulfillment core's own writers stay its own.
  ["the run's order or attempt writers", /OrderStateRepository|AttemptsRepository/],
  // S9e fix (CR F9): a HELD release asks the router which route the run would take (its cached
  // health), never an adapter to send, prepare or look a recipient up.
  ['an adapter send', /\.fulfill\s*\(/],
  ['an adapter prepare', /\.prepare\s*\(/],
  ['an adapter recipient lookup', /validateRecipient/],
  // S9i (S9e SA N-1): no raw write and no hand-made write of the attempt, the transfer or the order
  // history. Today no reconciler file has one (the late facts, the HELD release and refund write
  // through TonLateService, transitionOrder and failAndRefundOrder): no named exception is needed.
  // The model allowlist (reads only, no alias) and the one tagged $queryRaw: the -db spec.
  ['a raw SQL write', /\$executeRaw/],
  ['an unsafe raw query', /\$queryRawUnsafe/],
  ['a typed raw query', /\$queryRawTyped/],
  ['a hand-made attempt write', /fulfillmentAttempt\s*\.\s*(update|upsert|create|delete)\w*\s*\(/],
  ['a hand-made transfer write', /tonTransfer\s*\.\s*(update|upsert|create|delete)\w*\s*\(/],
  ['a hand-made order event', /orderEvent\s*\.\s*create\w*\s*\(/],
];

/** Writes a Redis client could make; the stuck-lease walk (S9d, Q-17) has none of them. */
const KEY_WRITE =
  /\.(del|unlink|set|setex|psetex|expire|pexpire|persist|getdel|getset|eval|evalsha|rename|hset|call|sendCommand|multi|pipeline)\s*\(/;

describe('the order reconciler (static)', () => {
  const files = sources(RECONCILER);

  function heldWriter(): string {
    const writer = files.filter((file) => relative(RECONCILER, file) === HELD_WRITER);
    expect(writer).toHaveLength(1);
    return writer.map(code).join('');
  }

  /**
   * The argument text of the one call `helper(tx, ...)` in held-writes.ts, up to its matching
   * parenthesis (nesting and strings counted, so no `}` inside it ends the argument early). The
   * name appears exactly twice (its import and this call: no alias, no second call), the argument
   * is `tx` and one object literal, with no spread.
   */
  function onlyCallOf(helper: string): string {
    const text = heldWriter();
    expect(text.match(new RegExp(`\\b${helper}\\b`, 'g'))).toHaveLength(2);
    const start = text.search(new RegExp(`\\b${helper}\\s*\\(`));
    expect(start).toBeGreaterThan(-1);
    const open = text.indexOf('(', start);
    const args = text.slice(open + 1, matching(text, open));
    expect(args).toMatch(/^\s*tx\s*,\s*\{[\s\S]*\}\s*,?\s*$/);
    expect(args).not.toMatch(/\.\.\./);
    return args;
  }

  it('has its files where the checks look', () => {
    const names = files.map((f) => relative(RECONCILER, f));
    expect(names).toEqual(
      expect.arrayContaining([
        'order-reconcile.module.ts',
        'transfer-sweep.step.ts',
        'review-sweep.step.ts',
        'review-resolver.ts',
        'stale-orders.step.ts',
        'order-lock-stuck.step.ts',
        'notice-resend.step.ts',
        'order-lock-keys.ts',
        'order-sweeps.repository.ts',
        'held-release-policy.ts',
        'held-sources.repository.ts',
        'held-evidence.ts',
        HELD_WRITER,
        'held-sweep.step.ts',
        'wallet-blocked.step.ts',
        'held-payout.ts',
        'late-facts.step.ts',
        'late-facts.repository.ts',
        'audit-effects.step.ts',
        'audit-effects.repository.ts',
      ]),
    );
  });

  it.each(FORBIDDEN_IN_RECONCILER)('never uses %s', (what, pattern) => {
    const hits = files.filter(
      (file) =>
        pattern.test(code(file)) &&
        !(what === 'a hand-made transition' && relative(RECONCILER, file) === HELD_WRITER),
    );
    expect(hits.map((f) => relative(WORKER_SRC, f))).toEqual([]);
  });

  it('S9e: applyTransition nowhere, held-writes.ts included', () => {
    expect(files.filter((file) => /applyTransition/.test(code(file)))).toEqual([]);
  });

  it('S9e: held-writes.ts imports from @repo/db only its helpers and types, by name', () => {
    const text = heldWriter();
    expect(text).not.toMatch(/import\s*\*|require\s*\(|import\s*\(/);
    expect(text.match(/from\s*'@repo\/db'/g)).toHaveLength(1);
    const block = /import\s*\{([^}]*)\}\s*from\s*'@repo\/db'/.exec(text);
    const names = (block?.[1] ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== '');
    expect(names.filter((n) => /\sas\s/.test(n))).toEqual([]);
    const bare = names.map((n) => n.replace(/^type\s+/, ''));
    expect(bare.filter((n) => !HELD_WRITER_DB_IMPORTS.includes(n))).toEqual([]);
    expect(bare).toEqual(expect.arrayContaining(['failAndRefundOrder', 'transitionOrder']));
  });

  it('S9e: held-writes.ts makes one transition only, HELD -> QUEUED by the system', () => {
    const args = onlyCallOf('transitionOrder');
    expect(args).toMatch(/\bfrom:\s*'HELD'\s*,/);
    expect(args).toMatch(/\bto:\s*'QUEUED'\s*,/);
    expect(args).toMatch(/\bactor:\s*'system'\s*,/);
  });

  it('S9e: held-writes.ts refunds only a HELD order held too long, as the system', () => {
    const args = onlyCallOf('failAndRefundOrder');
    expect(args).toMatch(/\bfrom:\s*'HELD'\s*,/);
    expect(args).toMatch(/\breason:\s*'HELD_EXPIRED'\s*,/);
    expect(args).toMatch(/\bactor:\s*'system'\s*,/);
  });

  it('the lease walk calls Redis with SCAN and GET only (S9d fix)', () => {
    const walk = files.filter((file) => relative(RECONCILER, file) === 'order-lock-keys.ts');
    const calls = walk.flatMap((file) =>
      [...code(file).matchAll(/\bthis\.redis\.(\w+)\s*\(/g)].map((m) => m[1]),
    );
    expect([...new Set(calls)].sort()).toEqual(['get', 'scan']);
  });

  it('touches Redis only for its own lease and the read-only walk over order leases (S9d)', () => {
    const redis = files.filter((file) => /\bRedisService\b/.test(code(file)));
    expect(redis.map((f) => relative(RECONCILER, f)).sort()).toEqual([
      'order-lock-keys.ts',
      'reconcile-order-lock.ts',
    ]);
    // A stuck lease may belong to a live holder: never deleted, rewritten or given a new TTL.
    const walk = files.filter((file) => relative(RECONCILER, file) === 'order-lock-keys.ts');
    expect(walk).toHaveLength(1);
    expect(walk.filter((file) => KEY_WRITE.test(code(file)))).toEqual([]);
  });

  it('moves money only through resolveNeedsReview (review) and failAndRefundOrder (HELD)', () => {
    const used: Record<string, string[]> = {};
    for (const file of files) {
      const names = [...code(file).matchAll(MONEY_HELPERS)].map((m) => m[1] ?? '');
      if (names.length > 0) used[relative(RECONCILER, file)] = [...new Set(names)].sort();
    }
    expect(used).toEqual(MONEY_HELPER_OWNERS);
  });

  it('writes a transfer EXPIRED nowhere in the worker but ton-outcome-writes.ts (item 23)', () => {
    // A Prisma write (`data: { status: 'EXPIRED' }`), the enum constant, or a raw SQL SET.
    const expiredWrite = [
      /data:\s*\{[^}]*\bstatus:\s*['"]EXPIRED['"]/,
      /TonTransferStatus\.EXPIRED/,
      /SET\s[^;]*"?status"?\s*=\s*'EXPIRED'/i,
    ];
    const hits = sources(WORKER_SRC)
      .filter((file) => expiredWrite.some((pattern) => pattern.test(code(file))))
      .map((f) => relative(WORKER_SRC, f).split(sep).join('/'));
    expect(hits).toEqual(['ton/ton-outcome-writes.ts']);
  });
});

/** The index of the bracket closing the one at `open` (quoted strings skipped). */
function matching(text: string, open: number): number {
  const pairs: Readonly<Record<string, string>> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) break;
      i = end;
    } else if (pairs[ch] !== undefined) {
      stack.push(pairs[ch] ?? '');
    } else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  throw new Error('no matching bracket');
}

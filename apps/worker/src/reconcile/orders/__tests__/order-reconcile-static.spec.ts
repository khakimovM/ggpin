import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// D-64 (1), plan §3 S9c and item 23: the order reconciler never signs, never pays, never takes the
// wallet lock, never re-broadcasts and never reads the chain itself (only TonConfirmService does);
// money moves only through `resolveNeedsReview` / `failAndRefundOrder`, never through a hand-made
// wallet lock, transition or ledger write. And in the whole worker only the TON module's outcome
// writer may set a transfer EXPIRED.

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
  ['a hand-made status write', /order\s*\.\s*update(Many)?\s*\(/],
  // S9c review CR5: no way to the chain or the outcome writes around TonConfirmService.check.
  ['the chain gateway', /TON_GATEWAY|\bTonGateway\b/],
  ['the chain reader', /TonChainReader/],
  ['the outcome writes', /TonOutcomeRepository/],
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
];

/** Writes a Redis client could make; the stuck-lease walk (S9d, Q-17) has none of them. */
const KEY_WRITE =
  /\.(del|unlink|set|setex|psetex|expire|pexpire|persist|getdel|getset|eval|evalsha|rename|hset|call|sendCommand|multi|pipeline)\s*\(/;

describe('the order reconciler (static)', () => {
  const files = sources(RECONCILER);

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
      ]),
    );
  });

  it.each(FORBIDDEN_IN_RECONCILER)('never uses %s', (_what, pattern) => {
    const hits = files.filter((file) => pattern.test(code(file)));
    expect(hits.map((f) => relative(WORKER_SRC, f))).toEqual([]);
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

  it('moves money only through resolveNeedsReview (or failAndRefundOrder)', () => {
    const helpers = files.filter((file) =>
      /resolveNeedsReview|failAndRefundOrder/.test(code(file)),
    );
    expect(helpers.map((f) => relative(RECONCILER, f))).toEqual(['review-resolver.ts']);
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

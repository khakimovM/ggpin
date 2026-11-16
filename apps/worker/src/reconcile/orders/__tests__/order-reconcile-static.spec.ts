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
];

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
      ]),
    );
  });

  it.each(FORBIDDEN_IN_RECONCILER)('never uses %s', (_what, pattern) => {
    const hits = files.filter((file) => pattern.test(code(file)));
    expect(hits.map((f) => relative(WORKER_SRC, f))).toEqual([]);
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

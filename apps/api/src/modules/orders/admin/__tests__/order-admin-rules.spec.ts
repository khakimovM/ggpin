import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ATTEMPT_HOLD_ERRORS } from '@repo/shared';
import { asRefusal, isDeadlock, retryOnDeadlock } from '../order-admin-errors';
import {
  assertBounceRecorded,
  deliversOutsideSystem,
  parseProof,
  resolveOtpTarget,
} from '../order-review.input';
import {
  assertOwnerChannel,
  cliChannelForCliModule,
  cliResolver,
  refuseCliResolverOverHttp,
} from '../operator-channel';

// The pure rules of the owner order commands (phase 5 S10).

const HEX = 'a'.repeat(64);
const REASON = 'checked twice';
const ACTOR = { operator: 'aziz', ip: '203.0.113.9', osUser: 'ops' };

describe('operator channel (I-4)', () => {
  it('only the CLI channel object is the owner; a string or a look-alike is not', () => {
    const lookAlike = { kind: 'CLI' };
    for (const channel of [undefined, null, 'HTTP', 'cli', 'CLI', lookAlike]) {
      expect(() => assertOwnerChannel(channel)).toThrow();
      expect(() => cliResolver(channel, ACTOR, true)).toThrow();
    }
    expect(Object.isFrozen(cliChannelForCliModule())).toBe(true);
    expect(cliResolver(cliChannelForCliModule(), ACTOR, false)).toEqual({
      kind: 'operator',
      type: 'CLI',
      id: 'aziz',
      ip: '203.0.113.9',
      osUser: 'ops',
      otpVerified: false,
    });
  });

  it('the HTTP boundary refuses a CLI or reconciler resolver whatever else it carries', () => {
    expect(() => refuseCliResolverOverHttp({ kind: 'operator', type: 'CLI', id: 'x' })).toThrow();
    expect(() => refuseCliResolverOverHttp({ kind: 'reconciler' })).toThrow();
    expect(() => refuseCliResolverOverHttp({ kind: 'operator', type: 'ADMIN' })).not.toThrow();
  });
});

describe('deadlock retry', () => {
  it('recognises 40P01 and P2034, nothing else', () => {
    expect(isDeadlock({ code: 'P2034' })).toBe(true);
    expect(isDeadlock(new Error('ERROR: deadlock detected 40P01'))).toBe(true);
    expect(isDeadlock(new Error('unique violation 23505'))).toBe(false);
  });

  it('retries a deadlock up to 3 runs, never another error', async () => {
    const work = jest.fn().mockRejectedValueOnce({ code: 'P2034' }).mockResolvedValue('ok');
    await expect(retryOnDeadlock(work)).resolves.toBe('ok');
    const other = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(retryOnDeadlock(other)).rejects.toThrow('boom');
    expect(other).toHaveBeenCalledTimes(1);
    const stuck = jest.fn().mockRejectedValue({ code: 'P2034' });
    await expect(retryOnDeadlock(stuck)).rejects.toEqual({ code: 'P2034' });
    expect(stuck).toHaveBeenCalledTimes(3);
  });
});

const WORKER_SRC = join(__dirname, '../../../../../../worker/src');

/** Every production .ts file of the worker (tests excluded), with its text. */
function workerSources(dir = WORKER_SRC): { readonly path: string; readonly text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : workerSources(path);
    if (!entry.name.endsWith('.ts') || entry.name.includes('.spec.')) return [];
    return [{ path, text: readFileSync(path, 'utf8') }];
  });
}

/** The shared names the worker must import, never declare (any declaration form, typed or not). */
const SHARED_NAMES = [
  'MAX_SEND_ATTEMPTS',
  'ATTEMPT_HOLD_ERRORS',
  'isAttemptHoldError',
  'CORE_HOLD_NOTE_PREFIX',
  'coreHoldNote',
  'TON_NOT_SENT_ERROR_PREFIX',
  'attemptLimitReached',
  'sendAttemptsUsed',
];
const DECLARATIONS = SHARED_NAMES.map(
  (name) => new RegExp(`\\b(?:function\\s*\\*?\\s*|(?:const|let|var)\\s+)${name}\\b`),
);
/** Two hold-error literals in one array literal: a copy of ATTEMPT_HOLD_ERRORS under any name. */
const HOLD_LITERAL = `['"](?:${ATTEMPT_HOLD_ERRORS.join('|')})['"]`;
const HOLD_LIST = new RegExp(`\\[[^\\]]*${HOLD_LITERAL}[^\\]]*${HOLD_LITERAL}[^\\]]*\\]`);
const LOCAL_COPIES = [...DECLARATIONS, HOLD_LIST];

function copiesIn(text: string): string[] {
  return LOCAL_COPIES.filter((copy) => copy.test(text)).map(String);
}

describe('attempt limit (phase 5 S9b): the worker takes the shared rule, it keeps no copy', () => {
  // Static: the owner CLI and the worker count with ONE implementation (packages/shared
  // attempt-limit.ts). A local copy in the worker could drift from what the CLI reports.
  it('the patterns catch every declaration form and a renamed hold-error list (CR L3)', () => {
    for (const copy of [
      'export const MAX_SEND_ATTEMPTS = 2;',
      'const MAX_SEND_ATTEMPTS: number = 2;',
      'let MAX_SEND_ATTEMPTS = 3',
      'export function isAttemptHoldError(error: string | null): boolean {',
      'const isAttemptHoldError = (e: string) => false;',
      'export const coreHoldNote = (r: string, w: string) => `${r}${w}`;',
      "const CORE_HOLD_NOTE_PREFIX: string = 'core hold: ';",
      "const TON_NOT_SENT_ERROR_PREFIX = 'TON_NOT_SENT_';",
      'function* sendAttemptsUsed() {}',
      "const KNOWN = ['LIMIT_DAILY', 'LOW_BALANCE'];",
      "const S5: readonly string[] = [\n  'LIMIT_PER_ORDER',\n  'X',\n  \"PAY_ADDRESS_NOT_ALLOWED\",\n];",
    ]) {
      expect({ copy, found: copiesIn(copy).length > 0 }).toEqual({ copy, found: true });
    }
  });

  it('the patterns leave imports, uses and single literals alone', () => {
    for (const clean of [
      "import { MAX_SEND_ATTEMPTS, isAttemptHoldError } from '@repo/shared';",
      'if (count >= MAX_SEND_ATTEMPTS) return hold();',
      'return isAttemptHoldError(attempt.error);',
      "const note = coreHoldNote('ADAPTER_ERROR', why);",
      "const reason = 'LIMIT_DAILY'; const other = ['LOW_BALANCE'];",
      "const reasons = ['LIMIT_DAILY', 'ADAPTER_ERROR'];",
      'const MAX_SEND_ATTEMPTS_SHOWN = 2;',
    ]) {
      expect({ clean, found: copiesIn(clean) }).toEqual({ clean, found: [] });
    }
  });

  it('no worker file defines the cap, the hold errors, the hold note or the not-sent prefix', () => {
    const sources = workerSources();
    expect(sources.length).toBeGreaterThan(50);
    const copies = sources.flatMap(({ path, text }) => {
      const file = relative(WORKER_SRC, path).replaceAll('\\', '/');
      // No exception left (S9c fix round): the TON module reads the shared ATTEMPT_HOLD_ERRORS too.
      return copiesIn(text).map((copy) => `${file}: ${copy}`);
    });
    expect(copies).toEqual([]);
  });

  it('the fresh run decides with the shared attemptLimitReached and the OWNER release', () => {
    const fresh = readFileSync(join(WORKER_SRC, 'fulfillment/fulfill-fresh.ts'), 'utf8');
    const shared = /import\s*\{([^}]*)\}\s*from\s*'@repo\/shared'/.exec(fresh)?.[1] ?? '';
    expect(shared).toMatch(/\battemptLimitReached\b/);
    expect(shared).toMatch(/\bATTEMPT_LIMIT_HOLD_WHY\b/);
    expect(fresh).toContain('attemptLimitReached(previous, await this.releasedAfter(');
    expect(fresh).toContain('clampRelease(await this.releases.lastOwnerRelease(');
  });
});

describe('asRefusal: the reuse indexes (CR m5)', () => {
  // The P2002 shape Prisma 7 + adapter-pg gives (payments/db-errors.ts, recorded in phase 4 S4).
  const unique = (index: string) => ({
    code: 'P2002',
    meta: { driverAdapterError: { cause: { constraint: { index } } } },
  });

  it('a racing resolution on the return or consuming tx index is the same refusal as the check', () => {
    expect(asRefusal(unique('AuditLog_review_return_tx_key'))).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'proof', reason: 'RETURN_TX_REUSED' },
    });
    expect(asRefusal(unique('AuditLog_review_consuming_tx_key'))).toMatchObject({
      details: { field: 'proof', reason: 'CONSUMING_TX_REUSED' },
    });
    const other = unique('Order_userId_idempotencyKey_key');
    expect(asRefusal(other)).toBe(other);
  });
});

describe('order:resolve input', () => {
  const notDebited = {
    kind: 'TON_NOT_DEBITED',
    transferId: 'ckt0000000000000000000001',
    txHash: HEX,
    txLt: '9',
    outMsgCount: 0,
  };

  it('the --reason goes into the proof; the code target binds the order, exit, kind and digest', () => {
    const proof = parseProof(notDebited, REASON, 'FAILED');
    expect(proof.reason).toBe(REASON);
    const target = resolveOtpTarget('o1', 'FAILED', proof);
    expect(target).toMatch(/^order o1 FAILED TON_NOT_DEBITED [0-9a-f]{12}$/);
    // Another proof (one digit of txLt) is another code.
    const other = parseProof({ ...notDebited, txLt: '8' }, REASON, 'FAILED');
    expect(resolveOtpTarget('o1', 'FAILED', other)).not.toBe(target);
  });

  it('audit I-1: the code of a TON_UNMATCHED_RESOLVED proof names its finding', () => {
    const unmatched = parseProof(
      {
        kind: 'TON_UNMATCHED_RESOLVED',
        transferId: 'ckt0000000000000000000001',
        finding: 'SENT_ELSEWHERE',
        consumingTxHash: HEX,
      },
      'value left to an address we do not know',
      'FAILED',
    );
    expect(resolveOtpTarget('o1', 'FAILED', unmatched)).toMatch(
      /^order o1 FAILED TON_UNMATCHED_RESOLVED SENT_ELSEWHERE [0-9a-f]{12}$/,
    );
  });

  it('I-8 (CR m6): only a MANUAL delivery whose open attempt has its own EXPIRED / ONCHAIN_FAILED transfer', () => {
    const manual = parseProof({ kind: 'MANUAL', evidence: 'x' }, REASON, 'DELIVERED');
    const open = (tonTransfer: object | null) => [{ status: 'UNKNOWN', tonTransfer }] as never[];
    expect(deliversOutsideSystem('DELIVERED', manual, open({ status: 'CONFIRMED' }))).toBe(false);
    expect(deliversOutsideSystem('DELIVERED', manual, open({ status: 'EXPIRED' }))).toBe(true);
    expect(deliversOutsideSystem('DELIVERED', manual, open({ status: 'ONCHAIN_FAILED' }))).toBe(
      true,
    );
    // No transfer of its own: nothing says the TON did not leave.
    expect(deliversOutsideSystem('DELIVERED', manual, open(null))).toBe(false);
    expect(deliversOutsideSystem('DELIVERED', manual, [])).toBe(false);
    // An older, already closed attempt's expired transfer does not count.
    const closed = [{ status: 'FAILED', tonTransfer: { status: 'EXPIRED' } }] as never[];
    expect(deliversOutsideSystem('DELIVERED', manual, closed)).toBe(false);
    const failed = parseProof({ kind: 'MANUAL', evidence: 'x' }, REASON, 'FAILED');
    expect(deliversOutsideSystem('FAILED', failed, open({ status: 'EXPIRED' }))).toBe(false);
  });

  it('TON_BOUNCED must equal the bounce the TON module recorded', () => {
    const bounce = {
      txHash: HEX,
      txLt: '10',
      returnTxHash: 'b'.repeat(64),
      returnLt: '16',
      returnedNanoTon: '230000000',
    };
    const proof = parseProof(
      { kind: 'TON_BOUNCED', transferId: 'ckt0000000000000000000001', ...bounce },
      REASON,
      'FAILED',
    );
    const attempt = (recorded: object) =>
      [
        {
          response: { ton: { bounce: recorded } },
          tonTransfer: { id: 'ckt0000000000000000000001' },
        },
      ] as never[];
    expect(() => assertBounceRecorded(proof, attempt(bounce))).not.toThrow();
    expect(() =>
      assertBounceRecorded(proof, attempt({ ...bounce, returnedNanoTon: '235000000' })),
    ).toThrow();
    expect(() => assertBounceRecorded(proof, [])).toThrow();
  });
});

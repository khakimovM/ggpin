// The panel's resolve proof (CR-M1, SA-L1): the phase 5 rules per kind, without `reason`.
import { describe, expect, it } from 'vitest';
import * as a from './index';

const H = (c: string) => c.repeat(64);
const ok = (value: unknown) => a.AdminResolveProofSchema.safeParse(value).success;

describe('AdminResolveProofSchema', () => {
  it('takes TON_TX with raw address and canonical logical time', () => {
    const tx = {
      kind: 'TON_TX',
      extMsgHash: H('a'),
      walletAddress: `0:${H('b')}`,
      txHash: H('c'),
      lt: '42',
    };
    expect(ok(tx)).toBe(true);
    expect(ok({ ...tx, lt: '042' })).toBe(false);
    expect(ok({ ...tx, walletAddress: `EQ${H('b')}` })).toBe(false);
  });

  it('proves "not sent" only with the same seqno, checked at least a minute after validUntil', () => {
    const base = {
      kind: 'TON_NOT_SENT',
      extMsgHash: H('a'),
      walletAddress: `-1:${H('b')}`,
      seqno: 7,
      validUntil: '2026-11-16T10:00:00.000Z',
      checkedSeqno: 7,
      checkedAt: '2026-11-16T10:01:00.000Z',
    };
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, checkedAt: '2026-11-16T10:00:59.999Z' })).toBe(false);
    expect(ok({ ...base, checkedSeqno: 8 })).toBe(false);
  });

  it('takes a bounce only after its own transaction and from another one', () => {
    const bounce = {
      kind: 'TON_BOUNCED',
      transferId: 'tt_1',
      txHash: H('a'),
      txLt: '100',
      returnTxHash: H('b'),
      returnLt: '101',
      returnedNanoTon: '990000000',
    };
    expect(ok(bounce)).toBe(true);
    expect(ok({ ...bounce, returnLt: '100' })).toBe(false);
    expect(ok({ ...bounce, returnTxHash: H('a') })).toBe(false);
    expect(ok({ ...bounce, returnLt: 'x' })).toBe(false);
    expect(ok({ ...bounce, returnedNanoTon: '0' })).toBe(false);
  });

  it('takes the other kinds with bounded text and literal values', () => {
    const notDebited = { kind: 'TON_NOT_DEBITED', transferId: 'tt_1', txHash: H('a'), txLt: '5' };
    expect(ok({ ...notDebited, outMsgCount: 0 })).toBe(true);
    expect(ok({ ...notDebited, outMsgCount: 1 })).toBe(false);
    const fragment = {
      kind: 'FRAGMENT_STATUS',
      requestRef: 'req-1',
      observedAt: '2026-11-16T10:00:00Z',
    };
    expect(ok({ ...fragment, status: 'DONE' })).toBe(true);
    expect(ok({ ...fragment, status: 'FAILED' })).toBe(false);
    expect(ok({ ...fragment, status: 'DONE', requestRef: 'x'.repeat(257) })).toBe(false);
  });

  it('asks the code for the owner-only kinds', () => {
    expect(a.ADMIN_RESOLVE_PROOF_KINDS).not.toContain('TON_UNMATCHED_RESOLVED');
    expect(a.ADMIN_RESOLVE_PROOF_KINDS.filter((k) => a.resolveProofNeedsCode(k))).toEqual([
      'TON_NOT_DEBITED',
      'TON_BOUNCED',
      'MANUAL',
    ]);
  });
});

describe('adminConfirmationCanonical', () => {
  it('drops a key whose value is undefined', () => {
    expect(
      a.adminConfirmationCanonical({
        action: 'admins.update',
        targetId: 'a_1',
        name: undefined,
        isActive: false,
      }),
    ).toBe('{"action":"admins.update","isActive":false,"targetId":"a_1"}');
  });
});

describe('adminConfirmationCanonical on nested arrays', () => {
  it('sorts keys inside arrays too (no body has one today; the binding must not depend on it)', () => {
    const odd = { action: 'sessions.revoke', targetId: 's_1', list: [{ b: 1, a: 2 }] };
    expect(a.adminConfirmationCanonical(odd as unknown as a.AdminConfirmationBody)).toBe(
      '{"action":"sessions.revoke","list":[{"a":2,"b":1}],"targetId":"s_1"}',
    );
  });
});

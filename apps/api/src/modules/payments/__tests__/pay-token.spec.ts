import { createHmac } from 'node:crypto';
import { PAY_TOKEN_PATTERN } from '@repo/shared';
import { generatePayToken, hashPayToken, payTokenCandidate, payTokenMatches } from '../pay-token';

const PEPPER = ['unit', 'pepper', 'x'.repeat(24)].join('-');

describe('pay-link token (D-39, plan §2.8)', () => {
  it('§2.8 issue: 32 random bytes as 43-char unpadded base64url, never the same twice', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generatePayToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(PAY_TOKEN_PATTERN);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    }
  });

  it('§2.8 storage: the hash is hex HMAC-SHA256(pepper, intentId + ":" + token)', () => {
    const token = generatePayToken();
    const expected = createHmac('sha256', PEPPER).update(`intent_1:${token}`).digest('hex');
    expect(hashPayToken(PEPPER, 'intent_1', token)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('§2.8 binding: a token hashes differently for another intent and another pepper', () => {
    const token = generatePayToken();
    const own = hashPayToken(PEPPER, 'intent_1', token);
    expect(hashPayToken(PEPPER, 'intent_2', token)).not.toBe(own);
    expect(hashPayToken(`${PEPPER}2`, 'intent_1', token)).not.toBe(own);
  });

  it('§2.8 rejection: a malformed id or token still costs one HMAC and is never well formed', () => {
    const token = generatePayToken();
    expect(payTokenCandidate(PEPPER, 'intent_1', token)).toEqual({
      lookupId: 'intent_1',
      hash: hashPayToken(PEPPER, 'intent_1', token),
      wellFormed: true,
    });
    const malformed: [string, string | undefined][] = [
      ['intent_1', undefined],
      ['intent_1', 'short'],
      ['intent_1', `${token}x`],
      ['intent_1', `${token.slice(0, 42)}=`],
      ['bad id!', token],
      ['x'.repeat(65), token],
    ];
    for (const [id, candidateToken] of malformed) {
      const candidate = payTokenCandidate(PEPPER, id, candidateToken);
      expect(candidate.wellFormed).toBe(false);
      expect(candidate.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // A malformed id is never looked up as typed.
    expect(payTokenCandidate(PEPPER, 'bad id!', token).lookupId).not.toBe('bad id!');
  });

  it('§2.8 comparison: constant-time equality; a missing or different stored hash never matches', () => {
    const hash = hashPayToken(PEPPER, 'intent_1', generatePayToken());
    expect(payTokenMatches(hash, hash)).toBe(true);
    expect(payTokenMatches(hash, null)).toBe(false);
    expect(payTokenMatches(hash, hashPayToken(PEPPER, 'intent_1', generatePayToken()))).toBe(false);
    expect(payTokenMatches(hash, 'abc')).toBe(false);
    expect(payTokenMatches('0'.repeat(64), null)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { createNonce, NONCE_PATTERN } from './nonce';

describe('createNonce', () => {
  it('is 16 random bytes in base64 (128 bits)', () => {
    const nonce = createNonce();
    expect(nonce).toMatch(NONCE_PATTERN);
    expect(atob(nonce)).toHaveLength(16);
  });

  it('differs on every call', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => createNonce()));
    expect(seen.size).toBe(2000);
  });

  it('uses the crypto source, not Math.random', () => {
    const original = Math.random;
    Math.random = () => 0;
    try {
      expect(createNonce()).not.toBe(createNonce());
    } finally {
      Math.random = original;
    }
  });
});

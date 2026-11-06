import { IDEMPOTENCY_KEY_PATTERN } from '@repo/shared';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdempotencyKey, useIdempotencyKey } from './idempotency';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createIdempotencyKey', () => {
  it('is a v4 UUID that the API accepts, and different every time', () => {
    const a = createIdempotencyKey();
    const b = createIdempotencyKey();
    expect(a).toMatch(UUID_V4);
    expect(a).toMatch(IDEMPOTENCY_KEY_PATTERN);
    expect(a).not.toBe(b);
  });

  it('still produces a valid key where crypto.randomUUID is unavailable (insecure context)', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array) => real.getRandomValues(array),
    });
    expect(createIdempotencyKey()).toMatch(UUID_V4);
  });
});

describe('useIdempotencyKey', () => {
  it('keeps the key across re-renders and changes it only on renew', () => {
    const { result, rerender } = renderHook(() => useIdempotencyKey());
    const [first] = result.current;
    rerender();
    expect(result.current[0]).toBe(first);

    act(() => result.current[1]());
    expect(result.current[0]).not.toBe(first);
    expect(result.current[0]).toMatch(UUID_V4);
  });
});

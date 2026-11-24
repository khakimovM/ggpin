import { ADMIN_PERMISSIONS, ADMIN_PERMISSION_KEYS } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { ADMIN_ACTION_KINDS } from '../idempotency-store';

describe('ADMIN_ACTION_KINDS', () => {
  it('is exactly the write keys of the shared matrix, without confirmations.create (I-1) and writeKeys.void (9-B: keyless)', () => {
    const writes = ADMIN_PERMISSION_KEYS.filter(
      (key) =>
        ADMIN_PERMISSIONS[key].write && key !== 'confirmations.create' && key !== 'writeKeys.void',
    );
    expect([...ADMIN_ACTION_KINDS].sort()).toEqual([...writes].sort());
  });

  it('has no duplicates', () => {
    expect(new Set(ADMIN_ACTION_KINDS).size).toBe(ADMIN_ACTION_KINDS.length);
  });
});

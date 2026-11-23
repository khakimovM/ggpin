import { describe, expect, it, vi } from 'vitest';
import {
  OUTCOME_WAIT_MS,
  expectedAuditId,
  findActionAudit,
  startNewAllowed,
  type AuditPageFetch,
} from '../idempotency-outcome';

describe('expectedAuditId', () => {
  it('matches the golden vector of the API test (admin-write-key.spec.ts, Q1 = A)', async () => {
    await expect(expectedAuditId('cmadmin0golden0vector00001', 'golden-key_0001')).resolves.toBe(
      'a4a27d4c0f956eb31c1081662e576705',
    );
  });

  it('depends on both the admin and the key', async () => {
    const base = await expectedAuditId('cmadmin0golden0vector00001', 'golden-key_0001');
    expect(await expectedAuditId('cmadmin0golden0vector00002', 'golden-key_0001')).not.toBe(base);
    expect(await expectedAuditId('cmadmin0golden0vector00001', 'golden-key_0002')).not.toBe(base);
  });
});

describe('startNewAllowed', () => {
  it('opens only 60 s after the last attempt', () => {
    expect(OUTCOME_WAIT_MS).toBe(60_000);
    expect(startNewAllowed(59_999)).toBe(false);
    expect(startNewAllowed(60_000)).toBe(true);
  });
});

const input = {
  adminId: 'cmadminowner01',
  targetId: 'mkuser000001',
  auditId: 'aWanted',
};

function pages(...lists: { id: string }[][]): AuditPageFetch {
  const total = lists.reduce((sum, list) => sum + list.length, 0);
  return vi.fn(({ page }) => Promise.resolve({ items: lists[page - 1] ?? [], meta: { total } }));
}

describe('findActionAudit', () => {
  it('filters by actor and target only: no `from`, the client clock plays no part (SA L-1)', async () => {
    const fetch = pages([{ id: 'aWanted' }]);
    await expect(findActionAudit(input, fetch)).resolves.toBe('found');
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'cmadminowner01',
        targetId: 'mkuser000001',
        page: 1,
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.not.objectContaining({ from: expect.anything() as unknown }),
    );
  });

  it('says notFound only after the whole list was read', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` }));
    const fetch = pages(first, [{ id: 'aOther' }]);
    await expect(findActionAudit(input, fetch)).resolves.toBe('notFound');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the list is longer than it reads', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` }));
    const fetch: AuditPageFetch = () => Promise.resolve({ items: full, meta: { total: 10_000 } });
    await expect(findActionAudit(input, fetch)).rejects.toThrow();
  });

  it('an empty page before the total is reached is never notFound', async () => {
    const fetch: AuditPageFetch = () => Promise.resolve({ items: [], meta: { total: 250 } });
    await expect(findActionAudit(input, fetch)).rejects.toThrow();
  });

  it('an empty LAST page short of the total is never notFound (CR M-1)', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` }));
    const fetch: AuditPageFetch = ({ page }) =>
      Promise.resolve({ items: page === 1 ? first : [], meta: { total: 150 } });
    await expect(findActionAudit(input, fetch)).rejects.toThrow();
  });

  it('an empty first page of a short list is never notFound (CR M-1)', async () => {
    const fetch: AuditPageFetch = () => Promise.resolve({ items: [], meta: { total: 50 } });
    await expect(findActionAudit(input, fetch)).rejects.toThrow();
  });

  it('a row added during the search (one repeats, the total grows) is never notFound', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` }));
    const fetch: AuditPageFetch = ({ page }) =>
      Promise.resolve(
        page === 1
          ? { items: first, meta: { total: 101 } }
          : { items: [{ id: 'a99' }, { id: 'a100' }], meta: { total: 102 } },
      );
    await expect(findActionAudit(input, fetch)).rejects.toThrow();
  });

  it('a failed request is never notFound', async () => {
    const fetch: AuditPageFetch = () => Promise.reject(new Error('500'));
    await expect(findActionAudit(input, fetch)).rejects.toThrow();
  });
});

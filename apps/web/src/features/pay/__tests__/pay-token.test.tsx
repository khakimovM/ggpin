import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPayToken, rememberPayExpiry, resetPayToken, usePayToken } from '../pay-token';

const mocks = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));

// Built, not spelled out: a 43-character base64url literal looks like a secret to scanners.
const TOKEN = `${'Tk'.repeat(21)}x`;
const OTHER = `${'Zq'.repeat(21)}y`;

function at(path: string) {
  window.history.replaceState(null, '', path);
}

beforeEach(() => {
  resetPayToken();
  mocks.replace.mockReset();
  at('/pay/cm3intent1');
});

describe('usePayToken', () => {
  it('reads the token from the fragment and takes the fragment out, keeping ?locale=', () => {
    at(`/pay/cm3intent1?locale=ru#t=${TOKEN}`);
    const { result } = renderHook(() => usePayToken('cm3intent1'));
    expect(result.current).toBe(TOKEN);
    expect(mocks.replace).toHaveBeenCalledWith('/pay/cm3intent1?locale=ru', { scroll: false });
  });

  it('keeps the token in memory when the fragment is gone (a re-render, a language switch)', () => {
    at(`/pay/cm3intent1#t=${TOKEN}`);
    const first = renderHook(() => usePayToken('cm3intent1'));
    expect(first.result.current).toBe(TOKEN);
    first.unmount();
    at('/pay/cm3intent1?locale=ru');
    const second = renderHook(() => usePayToken('cm3intent1'));
    expect(second.result.current).toBe(TOKEN);
  });

  it('a link without a token, or with a malformed one, has none', () => {
    const none = renderHook(() => usePayToken('cm3intent1'));
    expect(none.result.current).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
    none.unmount();
    resetPayToken();
    at('/pay/cm3intent1#t=short');
    const bad = renderHook(() => usePayToken('cm3intent1'));
    expect(bad.result.current).toBeNull();
  });

  it('a new link for the same request replaces the old token', () => {
    at(`/pay/cm3intent1#t=${TOKEN}`);
    renderHook(() => usePayToken('cm3intent1')).unmount();
    at(`/pay/cm3intent1#t=${OTHER}`);
    expect(renderHook(() => usePayToken('cm3intent1')).result.current).toBe(OTHER);
  });

  it('a token is never carried over to another request', () => {
    at(`/pay/cm3intent1#t=${TOKEN}`);
    renderHook(() => usePayToken('cm3intent1')).unmount();
    at('/pay/cm3intent2');
    expect(renderHook(() => usePayToken('cm3intent2')).result.current).toBeNull();
  });

  it('is kept in this tab’s sessionStorage only (by request), never in localStorage', () => {
    at(`/pay/cm3intent1#t=${TOKEN}`);
    renderHook(() => usePayToken('cm3intent1'));
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.parse(sessionStorage.getItem('ggpin:pay:cm3intent1') ?? 'null')).toEqual({
      intentId: 'cm3intent1',
      token: TOKEN,
      expiresAt: null,
    });
  });

  it('survives a reload: a fresh module finds the token in the tab’s storage', async () => {
    at(`/pay/cm3intent1#t=${TOKEN}`);
    renderHook(() => usePayToken('cm3intent1')).unmount();
    at('/pay/cm3intent1'); // the fragment is gone
    vi.resetModules();
    const reloaded = await import('../pay-token');
    expect(renderHook(() => reloaded.usePayToken('cm3intent1')).result.current).toBe(TOKEN);
  });

  it('writes the expiry beside the token, and an entry past it is erased and not used', async () => {
    at(`/pay/cm3intent1#t=${TOKEN}`);
    renderHook(() => usePayToken('cm3intent1')).unmount();
    rememberPayExpiry('cm3intent1', new Date(Date.now() - 1000).toISOString());
    expect(JSON.parse(sessionStorage.getItem('ggpin:pay:cm3intent1') ?? '{}')).toMatchObject({
      token: TOKEN,
    });
    at('/pay/cm3intent1');
    vi.resetModules();
    const reloaded = await import('../pay-token');
    expect(renderHook(() => reloaded.usePayToken('cm3intent1')).result.current).toBeNull();
    expect(sessionStorage.getItem('ggpin:pay:cm3intent1')).toBeNull();
  });

  it('clearPayToken erases storage and memory and tells the page at once', async () => {
    at(`/pay/cm3intent1#t=${TOKEN}`);
    const { result } = renderHook(() => usePayToken('cm3intent1'));
    expect(result.current).toBe(TOKEN);
    at('/pay/cm3intent1'); // what router.replace did to the address
    act(() => clearPayToken('cm3intent1'));
    expect(result.current).toBeNull();
    expect(sessionStorage.getItem('ggpin:pay:cm3intent1')).toBeNull();
    // ...and a reload does not bring it back.
    vi.resetModules();
    const reloaded = await import('../pay-token');
    expect(renderHook(() => reloaded.usePayToken('cm3intent1')).result.current).toBeNull();
  });

  it('a malformed entry in storage is ignored', () => {
    sessionStorage.setItem(
      'ggpin:pay:cm3intent1',
      JSON.stringify({ intentId: 'x', token: 'short' }),
    );
    expect(renderHook(() => usePayToken('cm3intent1')).result.current).toBeNull();
  });

  it('takes a link pasted into the same tab later (hashchange) and strips it', () => {
    const { result } = renderHook(() => usePayToken('cm3intent1'));
    expect(result.current).toBeNull();
    act(() => {
      at(`/pay/cm3intent1#t=${OTHER}`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(result.current).toBe(OTHER);
    expect(mocks.replace).toHaveBeenCalledWith('/pay/cm3intent1', { scroll: false });
  });

  it('reads the fragment when the module loads: Next rewrites the address before the first client snapshot', async () => {
    at(`/pay/cm3intent1?locale=ru#t=${TOKEN}`);
    vi.resetModules();
    const fresh = await import('../pay-token');
    // The router has already dropped the fragment by the time the hook first reads.
    at('/pay/cm3intent1?locale=ru');
    expect(renderHook(() => fresh.usePayToken('cm3intent1')).result.current).toBe(TOKEN);
    // ...and only for the request in the landing address.
    fresh.resetPayToken();
    at(`/pay/cm3intent1#t=${TOKEN}`);
    vi.resetModules();
    const other = await import('../pay-token');
    at('/pay/cm3intent2');
    expect(renderHook(() => other.usePayToken('cm3intent2')).result.current).toBeNull();
  });
});

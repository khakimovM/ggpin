import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPayToken,
  hasPayDone,
  markPayDone,
  resetPayToken,
  usePayDone,
  usePayToken,
} from '../pay-token';

const mocks = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));

// Built, not spelled out: a 43-character base64url literal looks like a secret to scanners.
const TOKEN = `${'Tk'.repeat(21)}x`;
const OTHER = `${'Zq'.repeat(21)}y`;
const KEY = (id: string) => `ggpin:pay:${id}`;
const FUTURE = new Date(Date.now() + 600_000).toISOString();

const at = (path: string) => window.history.replaceState(null, '', path);
const entry = (intentId: string, token: string, expiresAt: string | null) =>
  sessionStorage.setItem(KEY(intentId), JSON.stringify({ intentId, token, expiresAt }));

beforeEach(() => {
  resetPayToken();
  mocks.replace.mockReset();
  at('/pay/cm3intent1');
});
afterEach(() => vi.restoreAllMocks());

describe('storage writes', () => {
  it('a token that is already stored is not written again, and its known expiry is kept', () => {
    entry('cm3intent1', TOKEN, FUTURE);
    at(`/pay/cm3intent1#t=${TOKEN}`);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderHook(() => usePayToken('cm3intent1'));
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem(KEY('cm3intent1')) ?? '{}')).toEqual({
      intentId: 'cm3intent1',
      token: TOKEN,
      expiresAt: FUTURE,
    });
  });

  it('a NEW token for the same request replaces the stored one and starts without an expiry', () => {
    entry('cm3intent1', TOKEN, FUTURE);
    at(`/pay/cm3intent1#t=${OTHER}`);
    renderHook(() => usePayToken('cm3intent1'));
    expect(JSON.parse(sessionStorage.getItem(KEY('cm3intent1')) ?? '{}')).toMatchObject({
      token: OTHER,
      expiresAt: null,
    });
  });

  it('reading the page never writes: with no token nothing is stored', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderHook(() => usePayToken('cm3intent1'));
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe('one token per tab', () => {
  it('taking a token drops the tokens of other requests and any that have expired', () => {
    entry('cm3intent2', OTHER, FUTURE);
    entry('cm3intent3', OTHER, new Date(Date.now() - 1000).toISOString());
    at(`/pay/cm3intent1#t=${TOKEN}`);
    renderHook(() => usePayToken('cm3intent1'));
    expect(sessionStorage.getItem(KEY('cm3intent2'))).toBeNull();
    expect(sessionStorage.getItem(KEY('cm3intent3'))).toBeNull();
    expect(sessionStorage.getItem(KEY('cm3intent1'))).not.toBeNull();
  });

  it('a page with no token still sweeps the expired ones, and keeps the unexpired', () => {
    entry('cm3intent2', OTHER, FUTURE);
    entry('cm3intent3', OTHER, new Date(Date.now() - 1000).toISOString());
    renderHook(() => usePayToken('cm3intent1'));
    expect(sessionStorage.getItem(KEY('cm3intent3'))).toBeNull();
    expect(sessionStorage.getItem(KEY('cm3intent2'))).not.toBeNull();
  });
});

describe('the finished-request marker', () => {
  it('holds an id and a status and no token; it outlives the token', () => {
    at(`/pay/cm3intent1#t=${TOKEN}`);
    renderHook(() => usePayToken('cm3intent1'));
    at('/pay/cm3intent1');
    act(() => {
      markPayDone('cm3intent1', 'PAID');
      clearPayToken('cm3intent1');
    });
    const raw = sessionStorage.getItem('ggpin:pay-done:cm3intent1') ?? '';
    expect(JSON.parse(raw)).toEqual({ intentId: 'cm3intent1', status: 'PAID' });
    expect(raw).not.toContain(TOKEN);
    expect(sessionStorage.getItem(KEY('cm3intent1'))).toBeNull();
    expect(hasPayDone('cm3intent1')).toBe(true);
    expect(hasPayDone('cm3intent2')).toBe(false);
  });

  it('usePayDone follows it, and a malformed one counts for nothing', () => {
    const { result } = renderHook(() => usePayDone('cm3intent1'));
    expect(result.current).toBe(false);
    act(() => markPayDone('cm3intent1', 'EXPIRED'));
    expect(result.current).toBe(true);
    sessionStorage.setItem(
      'ggpin:pay-done:cm3intent2',
      JSON.stringify({ intentId: 'cm3intent2', status: 'ODD' }),
    );
    expect(hasPayDone('cm3intent2')).toBe(false);
  });

  it('resetPayToken removes only its own keys', () => {
    sessionStorage.setItem('someone-else', 'kept');
    entry('cm3intent1', TOKEN, null);
    markPayDone('cm3intent1', 'CANCELLED');
    resetPayToken();
    expect(sessionStorage.getItem(KEY('cm3intent1'))).toBeNull();
    expect(sessionStorage.getItem('ggpin:pay-done:cm3intent1')).toBeNull();
    expect(sessionStorage.getItem('someone-else')).toBe('kept');
  });
});

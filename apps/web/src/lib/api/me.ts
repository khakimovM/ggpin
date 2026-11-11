import {
  LedgerItemSchema,
  WalletResponseSchema,
  meSchema,
  type LedgerItem,
  type LedgerKind,
  type Me,
  type PageMeta,
  type UpdateMeBody,
  type WalletResponse,
} from '@repo/shared';
import { apiFetch, apiFetchList } from './client';

export interface LedgerFilters {
  kind?: LedgerKind;
  page?: number;
  limit?: number;
}

export function getMe(
  options: { session?: 'required' | 'optional'; signal?: AbortSignal } = {},
): Promise<Me> {
  return apiFetch({ path: '/me', session: options.session, signal: options.signal }, meSchema);
}

export function updateMe(body: UpdateMeBody): Promise<Me> {
  return apiFetch({ method: 'PATCH', path: '/me', body }, meSchema);
}

/** Balance and coins exactly as the server computed them; the browser never adds or subtracts. */
export function getWallet(signal?: AbortSignal): Promise<WalletResponse> {
  return apiFetch({ path: '/me/wallet', signal }, WalletResponseSchema);
}

export function getLedger(
  filters: LedgerFilters = {},
  signal?: AbortSignal,
): Promise<{ items: LedgerItem[]; meta: PageMeta }> {
  const { kind, page, limit } = filters;
  return apiFetchList(
    { path: '/me/ledger', query: { kind, page, limit }, signal },
    LedgerItemSchema,
  );
}

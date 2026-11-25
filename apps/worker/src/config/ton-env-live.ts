import { Address } from '@ton/core';
import { TonAddressError, parseOrderPayoutAddress, rawAddress } from '../ton/ton-address';
import type { TonNetwork } from '../ton/ton-mnemonic';

// TON settings that matter once value can really leave (FULFILLMENT_DRY_RUN=false), and the
// payout allowlist (plan §5 FRAGMENT_PAY_ADDRESSES, D-56 (5) Q7). Messages name the variable and
// the rule, never a value. Sources: audit L1 (allowlist), L4 (endpoint and network), L5 (limits
// given explicitly), M2 (the API key), D-60 (2) (a second chain source before mainnet).

/** toncenter's v2 hosts and the network each one serves. A Map: no prototype keys. */
export const TONCENTER_HOSTS: ReadonlyMap<string, TonNetwork> = new Map<string, TonNetwork>([
  ['toncenter.com', 'mainnet'],
  ['testnet.toncenter.com', 'testnet'],
]);

/** The limits a live worker must be given explicitly (their defaults are for dry runs only). */
export const LIVE_EXPLICIT_LIMITS = ['TON_MAX_PER_ORDER_NANO', 'TON_MAX_DAILY_NANO'] as const;

/**
 * https always (the X-API-Key header travels with every call), and the host must serve
 * TON_NETWORK: a mainnet worker never takes its confirmations from an unknown or a testnet host,
 * where a copy of our wallet could be deployed and "pay" with test coins.
 */
export function endpointProblems(endpoint: string, network: TonNetwork): string[] {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return ['TON_API_ENDPOINT: is not a URL'];
  }
  const problems: string[] = [];
  if (url.protocol !== 'https:') {
    problems.push('TON_API_ENDPOINT: must use https whenever FULFILLMENT_DRY_RUN=false');
  }
  // Audit I-2: `toncenter.com.` (a fully qualified name) is the same host as `toncenter.com`.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  const served = TONCENTER_HOSTS.get(host);
  if (served !== undefined && served !== network) {
    problems.push(`TON_API_ENDPOINT: serves ${served}, not TON_NETWORK=${network}`);
  }
  if (served === undefined && network === 'mainnet') {
    problems.push('TON_API_ENDPOINT: not a known mainnet endpoint (toncenter.com)');
  }
  return problems;
}

/** A user-friendly address flagged test-only cannot be a mainnet address. */
function testOnlyOnMainnet(text: string, network: TonNetwork): boolean {
  return (
    network === 'mainnet' && Address.isFriendly(text) && Address.parseFriendly(text).isTestOnly
  );
}

export interface PayAddressList {
  /** Raw, lowercase, deduplicated (the TonTransfer.toAddress spelling). */
  readonly raw: readonly string[];
  readonly problems: readonly string[];
}

/** FRAGMENT_PAY_ADDRESSES: comma-separated, raw or user-friendly, workchain 0 only. */
export function parsePayAddresses(text: string | undefined, network: TonNetwork): PayAddressList {
  if (text === undefined) return { raw: [], problems: [] };
  const raw = new Set<string>();
  const problems: string[] = [];
  const entries = text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  entries.forEach((entry, index) => {
    const what = `FRAGMENT_PAY_ADDRESSES: entry ${String(index + 1)}`;
    try {
      const address = parseOrderPayoutAddress(entry, what);
      if (testOnlyOnMainnet(entry, network)) {
        problems.push(`${what} is a test-only address on mainnet`);
        return;
      }
      raw.add(rawAddress(address));
    } catch (error) {
      if (!(error instanceof TonAddressError)) throw error;
      problems.push(error.message);
    }
  });
  return { raw: [...raw], problems };
}

export interface LiveTonEnv {
  readonly TON_NETWORK: TonNetwork;
  readonly TON_API_ENDPOINT?: string | undefined;
  readonly TON_API_KEY?: string | undefined;
  readonly TON_WALLET_ADDRESS?: string | undefined;
  readonly FRAGMENT_PAY_ADDRESSES?: string | undefined;
}

/** Only for FULFILLMENT_DRY_RUN=false. `source` is the env as given (before any default). */
export function liveTonProblems(
  env: LiveTonEnv,
  source: Readonly<Record<string, string | undefined>>,
): string[] {
  const problems: string[] = [];
  const network = env.TON_NETWORK;
  if (env.TON_API_KEY === undefined) {
    problems.push(
      'TON_API_KEY: is required with FULFILLMENT_DRY_RUN=false (no keyless rate limit)',
    );
  }
  // Fragment pays on mainnet only. A live testnet worker (the self-test, the S12 rehearsal) may
  // run without the list: every ORDER payout is then HELD before signing, never sent.
  const payees = parsePayAddresses(env.FRAGMENT_PAY_ADDRESSES, network).raw;
  if (network === 'mainnet' && payees.length === 0) {
    problems.push(
      'FRAGMENT_PAY_ADDRESSES: at least one address is required on mainnet with FULFILLMENT_DRY_RUN=false',
    );
  }
  for (const name of LIVE_EXPLICIT_LIMITS) {
    if (source[name] === undefined) {
      problems.push(`${name}: must be set explicitly with FULFILLMENT_DRY_RUN=false (no default)`);
    }
  }
  if (env.TON_API_ENDPOINT !== undefined) {
    problems.push(...endpointProblems(env.TON_API_ENDPOINT, network));
  }
  const wallet = env.TON_WALLET_ADDRESS;
  if (wallet !== undefined && testOnlyOnMainnet(wallet, network)) {
    problems.push('TON_WALLET_ADDRESS: is a test-only address on mainnet');
  }
  // D-60 (2): EXPIRED (which lets a payout be sent again or refunded) rests on one provider until
  // a second, independent source exists; it is mandatory before mainnet, and its env comes then.
  if (network === 'mainnet') {
    problems.push(
      'TON_NETWORK=mainnet: a second, independent chain source for the EXPIRED proof is mandatory first (D-60 (2))',
    );
  }
  return problems;
}

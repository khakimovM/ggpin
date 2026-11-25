import { parseMajor } from '@repo/shared';
import type { WorkerConfig } from '../config/config.module';
import { parsePayAddresses } from '../config/ton-env-live';
import { DisabledTonGateway } from './disabled-ton.gateway';
import { FakeTonGateway } from './fake-ton.gateway';
import { DEFAULT_EXPIRY_GAP_SEC } from './ton-expiry';
import type { TonChainWitness, TonGateway } from './ton-gateway';
import {
  DEFAULT_DEST_GRACE_SEC,
  DEFAULT_LOCK_TTL_MS,
  DEFAULT_MAX_CLOCK_SKEW_SEC,
  DEFAULT_POLL_MS,
  type TonHotWalletAddress,
  type TonPayAddresses,
  type TonTiming,
} from './ton-tokens';
import { ToncenterGateway } from './toncenter.gateway';
import { TonWalletError, dryRunTonWallet, openTonWallet, type TonWallet } from './ton-wallet';

// Which wallet and which chain exist is decided here and only here (plan §8, "Simulyator va
// dry-run kafolatlari"):
//
// | FULFILLMENT_DRY_RUN | NODE_ENV    | wallet                         | chain              |
// | true                | dev / test  | random key of this process     | FakeTonGateway     |
// | true                | production  | random key of this process     | DisabledTonGateway |
// | false               | any         | TON_MNEMONIC_ENC (address-checked) | ToncenterGateway |
//
// In a dry run no wallet secret is read (the config does not even keep it) and no TonClient is
// constructed, so nothing can reach toncenter, testnet or mainnet.

/** What the dry-run wallet holds on the fake chain of a dev worker: enough for local testing. */
export const DRY_RUN_WALLET_BALANCE_NANO = parseMajor('TON', '1000');

/**
 * The real wallet takes its key material from the config's one-shot handle (audit L2): after
 * this, nothing in the process but the wallet object itself can open the mnemonic again.
 */
export async function buildTonWallet(config: WorkerConfig): Promise<TonWallet> {
  if (config.FULFILLMENT_DRY_RUN) return dryRunTonWallet(config.TON_NETWORK);
  const secret = config.TON_WALLET_SECRET?.take() ?? null;
  if (secret === null) throw new TonWalletError('MISSING_SECRET');
  return openTonWallet({
    network: config.TON_NETWORK,
    mnemonicBlob: secret.mnemonicBlob,
    keyText: secret.keyText,
    expectedAddress: config.TON_WALLET_ADDRESS,
  });
}

export function buildTonGateway(config: WorkerConfig, wallet: TonWallet): TonGateway {
  const production = config.NODE_ENV === 'production';
  if (!config.FULFILLMENT_DRY_RUN) {
    const endpoint = config.TON_API_ENDPOINT;
    // The env check already refuses a live config without it; this keeps the type honest.
    if (endpoint === undefined) throw new Error('TON_API_ENDPOINT is required with DRY_RUN=false');
    return new ToncenterGateway({ endpoint, apiKey: config.TON_API_KEY, dryRun: false });
  }
  if (production) return new DisabledTonGateway();
  const fake = new FakeTonGateway({ production, dryRun: true });
  fake.registerWallet(wallet, DRY_RUN_WALLET_BALANCE_NANO);
  return fake;
}

export function tonTimingOf(config: WorkerConfig): TonTiming {
  return {
    pollMs: DEFAULT_POLL_MS,
    destGraceSec: DEFAULT_DEST_GRACE_SEC,
    confirmTimeoutMs: config.TON_CONFIRM_TIMEOUT_MS,
    lockTtlMs: DEFAULT_LOCK_TTL_MS,
    maxClockSkewSec: DEFAULT_MAX_CLOCK_SKEW_SEC,
    expiryGapSec: DEFAULT_EXPIRY_GAP_SEC,
  };
}

/** FRAGMENT_PAY_ADDRESSES as raw addresses (validated at boot; empty when unset in a dry run). */
export function tonPayAddressesOf(config: WorkerConfig): TonPayAddresses {
  return new Set(parsePayAddresses(config.FRAGMENT_PAY_ADDRESSES, config.TON_NETWORK).raw);
}

/**
 * Second chain sources for the EXPIRED proof (D-60 (2)). None exists yet: the env refuses a live
 * mainnet worker until one does (ton-env-live.ts); its gateway and env come with S12.
 */
export function tonExpiryWitnessesOf(): readonly TonChainWitness[] {
  return [];
}

export function hotWalletAddressOf(wallet: TonWallet): TonHotWalletAddress {
  return { network: wallet.network, address: wallet.address, rawAddress: wallet.rawAddress };
}

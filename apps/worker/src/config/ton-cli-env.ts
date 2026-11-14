import { z } from 'zod';
import type { TonNetwork } from '../ton/ton-mnemonic';
import { EnvValidationError } from './env';
import type { SecretFileReader } from './secret-file';
import { forgetWalletSecrets, walletKeySource } from './ton-env';

export interface TonKeyEnv {
  readonly network: TonNetwork;
  readonly key: string;
}

const networkSchema = z.enum(['testnet', 'mainnet']).default('testnet');

/**
 * What `ton:encrypt-mnemonic` needs and nothing else (the full worker config refuses a live setup
 * that has no mnemonic yet): TON_NETWORK (testnet by default, like the worker) and the wallet key
 * the worker's way (D-52 D3): WALLET_ENC_KEY_FILE, or inline WALLET_ENC_KEY outside production.
 * The key variables leave `source` once read. Messages name variables, never values.
 */
export function loadTonKeyEnv(
  source: NodeJS.ProcessEnv = process.env,
  readSecret?: SecretFileReader,
): TonKeyEnv {
  const clean = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const production = clean.NODE_ENV === 'production';
  const network = networkSchema.safeParse(clean.TON_NETWORK);
  const key = walletKeySource(clean, production, false, readSecret);
  forgetWalletSecrets(source);
  const problems = [...key.problems];
  if (!network.success) problems.push('TON_NETWORK: must be testnet or mainnet');
  if (key.key === undefined && key.problems.length === 0) {
    problems.push(
      'WALLET_ENC_KEY_FILE (or WALLET_ENC_KEY outside production): is required but not set',
    );
  }
  if (!network.success || key.key === undefined || problems.length > 0) {
    throw new EnvValidationError(problems);
  }
  return Object.freeze({ network: network.data, key: key.key });
}

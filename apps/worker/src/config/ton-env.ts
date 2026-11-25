import { TON_NOT_SENT_MARGIN_MS } from '@repo/shared';
import { Address } from '@ton/core';
import { z } from 'zod';
import { DEFAULT_EXPIRY_GAP_SEC } from '../ton/ton-expiry';
import { DEFAULT_MAX_CLOCK_SKEW_SEC, DEFAULT_POLL_MS, signLagMaxSec } from '../ton/ton-tokens';
import { TonSecretError, checkMnemonicBlob, type TonNetwork } from '../ton/ton-mnemonic';
import { SecretFileError, readSecretFile, type SecretFileReader } from './secret-file';
import { liveTonProblems, parsePayAddresses } from './ton-env-live';

// Money knobs are BigInt minor units parsed from digit strings (CLAUDE.md §5.1), like env.ts.
const nanoString = (fallback: string) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer written with digits only')
    .default(fallback)
    .transform((v) => BigInt(v));

function isTonAddress(value: string): boolean {
  try {
    Address.parse(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * TON knobs of the worker (plan §5, D-56; the env names of that table only).
 *
 * - TON_WALLET_ADDRESS: the hot wallet the mnemonic must derive (W5R1 on TON_NETWORK). A boot whose
 *   mnemonic gives another address is refused (ton-wallet.ts). Not a secret.
 * - WALLET_ENC_KEY_FILE: the Docker-secret file holding WALLET_ENC_KEY (D-52 D3 pattern; the only
 *   way in production). Inline WALLET_ENC_KEY is for dev/test.
 * - TON_SEND_VALID_SEC: `valid_until` of a signed message, seconds after the chain time it is signed at.
 * - TON_CONFIRM_TIMEOUT_MS: how long a payout is watched before the order goes to NEEDS_REVIEW
 *   (docs/06: 5 minutes; it must outlast the EXPIRED proof, see workerTonProblems).
 * - TON_FEE_RESERVE_NANO: kept on top of the amount when the balance is checked (D-56 (12)).
 * - FRAGMENT_PAY_ADDRESSES: the only addresses an ORDER payout may go to (Q7; comma-separated,
 *   workchain 0). Required on a live mainnet worker; an ORDER payout to any other address is HELD
 *   before signing (audit L1), so an empty list holds every ORDER payout.
 */
/** The longest TON_CONFIRM_TIMEOUT_MS accepted (10 minutes). */
export const TON_CONFIRM_TIMEOUT_MAX_MS = 600_000;

/**
 * Room for the polls in the wait (review RR2 #4): the first observation is taken at the first look
 * after its point in time, up to one poll late, and the second one too. How long one look itself
 * takes (15 s per request, several requests) is not counted here: docs/06 says why.
 */
export const CONFIRM_POLL_RESERVE_MS = 2 * DEFAULT_POLL_MS;

export const workerTonShape = {
  TON_WALLET_ADDRESS: z
    .string()
    .refine(isTonAddress, 'must be a TON address (raw <workchain>:<64 hex> or user-friendly)')
    .optional(),
  WALLET_ENC_KEY_FILE: z.string().optional(),
  TON_SEND_VALID_SEC: z.coerce.number().int().min(30).max(300).default(60),
  TON_CONFIRM_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(TON_CONFIRM_TIMEOUT_MAX_MS)
    .default(300_000),
  TON_FEE_RESERVE_NANO: nanoString('50000000'),
  FRAGMENT_PAY_ADDRESSES: z.string().optional(),
} as const;

export interface WorkerTonEnv {
  readonly FULFILLMENT_DRY_RUN: boolean;
  readonly TON_NETWORK: TonNetwork;
  readonly TON_API_ENDPOINT?: string | undefined;
  readonly TON_API_KEY?: string | undefined;
  readonly TON_MNEMONIC_ENC?: string | undefined;
  readonly WALLET_ENC_KEY?: string | undefined;
  readonly TON_WALLET_ADDRESS?: string | undefined;
  readonly FRAGMENT_PAY_ADDRESSES?: string | undefined;
  readonly TON_SEND_VALID_SEC: number;
  readonly TON_CONFIRM_TIMEOUT_MS: number;
}

type Source = Readonly<Record<string, string | undefined>>;

export interface WalletKeySource {
  /** The key text (from the file, or inline outside production); undefined in dry run. */
  readonly key: string | undefined;
  readonly problems: readonly string[];
}

/**
 * Where WALLET_ENC_KEY comes from (D-52 D3, D-56 (8)): WALLET_ENC_KEY_FILE (a Docker secret; the
 * only way in production) or inline WALLET_ENC_KEY (dev/test). Both at once is refused. In dry run
 * the key is not read at all (plan §8: no wallet secret is touched while nothing can be sent).
 */
export function walletKeySource(
  source: Source,
  production: boolean,
  dryRun: boolean,
  read: SecretFileReader = (path) => readSecretFile(path, process.platform, production),
): WalletKeySource {
  const inline = source.WALLET_ENC_KEY;
  const file = source.WALLET_ENC_KEY_FILE;
  const problems: string[] = [];
  if (inline !== undefined && file !== undefined) {
    problems.push('WALLET_ENC_KEY and WALLET_ENC_KEY_FILE: set only one of them');
  }
  if (production && inline !== undefined) {
    problems.push(
      'WALLET_ENC_KEY: an inline key is refused in production; use WALLET_ENC_KEY_FILE (a Docker secret)',
    );
  }
  if (problems.length > 0 || dryRun) return { key: undefined, problems };
  if (file === undefined) return { key: inline, problems };
  try {
    return { key: read(file), problems };
  } catch (error) {
    const reason = error instanceof SecretFileError ? error.message : 'cannot be read';
    return { key: undefined, problems: [`WALLET_ENC_KEY_FILE: ${reason}`] };
  }
}

const KEY_LABEL = 'WALLET_ENC_KEY_FILE (or WALLET_ENC_KEY outside production)';

/**
 * Cross-field rules. Messages name the variables, never a value. `source` is the env as given
 * (before defaults): a live worker must set its limits itself.
 */
export function workerTonProblems(
  env: WorkerTonEnv,
  source: Readonly<Record<string, string | undefined>>,
): string[] {
  const problems: string[] = [];
  // An unsent message is provably dead only after two observations past validUntil + the margin,
  // DEFAULT_EXPIRY_GAP_SEC apart (D-60 (2)), by the DATABASE clock, which counts the wait from
  // `createdAt`. validUntil is counted from the chain time at signing, which may be ahead of the
  // database clock by up to signLagMaxSec (review m2). The wait must reach the second one in the
  // worst case, or every lost message would end in NEEDS_REVIEW instead of a proven EXPIRED; two
  // polls of reserve, since each observation may come one poll late (review RR2 #4).
  const skewSec = signLagMaxSec({ maxClockSkewSec: DEFAULT_MAX_CLOCK_SKEW_SEC });
  const proofMs =
    env.TON_SEND_VALID_SEC * 1_000 +
    TON_NOT_SENT_MARGIN_MS +
    DEFAULT_EXPIRY_GAP_SEC * 1_000 +
    skewSec * 1_000 +
    CONFIRM_POLL_RESERVE_MS;
  if (env.TON_CONFIRM_TIMEOUT_MS <= proofMs) {
    problems.push(
      `TON_CONFIRM_TIMEOUT_MS: must be longer than TON_SEND_VALID_SEC + ${String(TON_NOT_SENT_MARGIN_MS / 1_000)} s + ${String(DEFAULT_EXPIRY_GAP_SEC)} s + ${String(skewSec)} s (clock skew at signing) + ${String(CONFIRM_POLL_RESERVE_MS / 1_000)} s (two polls)`,
    );
  }
  problems.push(...parsePayAddresses(env.FRAGMENT_PAY_ADDRESSES, env.TON_NETWORK).problems);
  if (env.FULFILLMENT_DRY_RUN) return problems;
  const required: readonly (readonly [string, string | undefined])[] = [
    ['TON_API_ENDPOINT', env.TON_API_ENDPOINT],
    ['TON_MNEMONIC_ENC', env.TON_MNEMONIC_ENC],
    [KEY_LABEL, env.WALLET_ENC_KEY],
    ['TON_WALLET_ADDRESS', env.TON_WALLET_ADDRESS],
  ];
  for (const [name, value] of required) {
    if (value === undefined) problems.push(`${name}: is required with FULFILLMENT_DRY_RUN=false`);
  }
  problems.push(...liveTonProblems(env, source));
  if (env.WALLET_ENC_KEY !== undefined && env.TON_MNEMONIC_ENC !== undefined) {
    try {
      checkMnemonicBlob(env.TON_MNEMONIC_ENC, env.WALLET_ENC_KEY, env.TON_NETWORK);
    } catch (error) {
      if (!(error instanceof TonSecretError)) throw error;
      problems.push(error.message);
    }
  }
  return problems;
}

/**
 * After the boot read (D-52 D3): the wallet key, its file path, the encrypted mnemonic and the
 * TON API key leave the process environment, so a child process, a crash dump of `process.env` or
 * a later library cannot see them (review m3). The config keeps the API key (the gateway sends it)
 * and a one-shot handle of the wallet pair (wallet-secret.ts), never the pair itself.
 */
export function forgetWalletSecrets(env: NodeJS.ProcessEnv): void {
  delete env.WALLET_ENC_KEY;
  delete env.WALLET_ENC_KEY_FILE;
  delete env.TON_MNEMONIC_ENC;
  delete env.TON_API_KEY;
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import { z } from 'zod';
import { AesGcmError, parseAesKey } from '../crypto/aes-gcm';
import { networkEnvRefusals, networkFlagRefusals } from './network-env';
import { SecretFileError, readSecretFile, type SecretFileReader } from './secret-file';

// The Fragment session key and the keep-alive period (plan §5, phase 5 S7):
//
// - FRAGMENT_SESSION_ENC_KEY_FILE: the Docker-secret file holding FRAGMENT_SESSION_ENC_KEY (D-52
//   D3, Q14; the only way in production). Inline FRAGMENT_SESSION_ENC_KEY is for dev/test. Both
//   at once is refused. 32 random bytes, base64 (it opens FragmentSession.cookiesEnc, AES-256-GCM).
//   In a dry run it is not read at all (plan §8: no Fragment cookie is touched while nothing can
//   be sent), so the config does not even hold it.
// - FRAGMENT_KEEPALIVE_EVERY_MS: how often the keep-alive looks at the session (20 minutes).

export const FRAGMENT_KEEPALIVE_DEFAULT_MS = 1_200_000;

/** What the key fingerprint is a keyed hash of (never used to seal anything). */
export const FINGERPRINT_LABEL = 'ggpin/fragment-session/fp';

export const workerFragmentShape = {
  FRAGMENT_SESSION_ENC_KEY_FILE: z.string().optional(),
  // At least a minute (Fragment must not see a bot), at most an hour (a session that dies is
  // noticed within two periods).
  FRAGMENT_KEEPALIVE_EVERY_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(3_600_000)
    .default(FRAGMENT_KEEPALIVE_DEFAULT_MS),
} as const;

/**
 * FRAGMENT_SESSION_ENC_KEY in the frozen config: a holder that prints and serializes as a
 * placeholder (like TonApiKey), so a logged or inspected config shows nothing. Its one reader is
 * the session store (fragment-session.store.ts).
 */
export class FragmentSessionKey {
  readonly #key: Buffer;

  /** Throws AesGcmError('BAD_KEY') for anything but 32 random bytes in base64. */
  constructor(base64Key: string) {
    this.#key = parseAesKey(base64Key);
  }

  /**
   * For the session store only: a COPY (audit I-8), so a caller that zeroes its buffer after use
   * (the store does) never wipes the key itself, and no caller can change the held key.
   */
  bytesForSessionStore(): Buffer {
    return Buffer.from(this.#key);
  }

  /**
   * 8 hex characters of HMAC-SHA256(key, FINGERPRINT_LABEL) (audit L-4): printed by the import CLI
   * and at worker boot, so the owner can see that both use the same key without either showing
   * it. 32 bits of a keyed hash: tells keys apart, reveals nothing usable about the key.
   */
  fingerprint(): string {
    return createHmac('sha256', this.#key).update(FINGERPRINT_LABEL).digest('hex').slice(0, 8);
  }

  /**
   * Whether another key (base64, e.g. WALLET_ENC_KEY) holds the same bytes (S7 audit I-11: one
   * leaked key must not open both the wallet and the Fragment session). Constant time; a text that
   * is not a key is simply "not the same" (its own loader reports it).
   */
  sameAs(otherBase64Key: string): boolean {
    let other: Buffer;
    try {
      other = parseAesKey(otherBase64Key.trim());
    } catch {
      return false;
    }
    try {
      return timingSafeEqual(other, this.#key);
    } finally {
      other.fill(0);
    }
  }

  toJSON(): string {
    return '[redacted]';
  }

  toString(): string {
    return '[redacted]';
  }

  [inspect.custom](): string {
    return 'FragmentSessionKey([redacted])';
  }
}

export interface FragmentKeySource {
  readonly key: FragmentSessionKey | undefined;
  readonly problems: readonly string[];
}

type Source = Readonly<Record<string, string | undefined>>;

const INLINE = 'FRAGMENT_SESSION_ENC_KEY';
const FILE = 'FRAGMENT_SESSION_ENC_KEY_FILE';

/**
 * Where FRAGMENT_SESSION_ENC_KEY comes from (D-52 D3, the walletKeySource pattern). `readKey`:
 * false in a dry-run worker (the key is checked for "both set" and "inline in production" but
 * never read). Messages name the variable, never the path or the value.
 */
export function fragmentKeySource(
  source: Source,
  production: boolean,
  readKey: boolean,
  read: SecretFileReader = (path) => readSecretFile(path, process.platform, production),
): FragmentKeySource {
  const inline = source[INLINE];
  const file = source[FILE];
  const problems: string[] = [];
  if (inline !== undefined && file !== undefined) {
    problems.push(`${INLINE} and ${FILE}: set only one of them`);
  }
  if (production && inline !== undefined) {
    problems.push(
      `${INLINE}: an inline key is refused in production; use ${FILE} (a Docker secret)`,
    );
  }
  if (problems.length > 0 || !readKey) return { key: undefined, problems };
  let text = inline;
  if (file !== undefined) {
    try {
      text = read(file);
    } catch (error) {
      const reason = error instanceof SecretFileError ? error.message : 'cannot be read';
      return { key: undefined, problems: [`${FILE}: ${reason}`] };
    }
  }
  if (text === undefined) return { key: undefined, problems };
  try {
    return { key: new FragmentSessionKey(text), problems };
  } catch (error) {
    if (!(error instanceof AesGcmError)) throw error;
    return {
      key: undefined,
      problems: [`${file === undefined ? INLINE : FILE}: ${error.message}`],
    };
  }
}

/**
 * What a worker with FULFILLMENT_DRY_RUN=false needs on top of a readable key (S7 audit L-4,
 * L-2): the session key is REQUIRED, like the wallet key (a live keep-alive without it could only
 * ever fail with NO_KEY and kill a good session), and no variable that would weaken or redirect
 * Node's HTTPS (TLS checks off, extra/system/OpenSSL CA, an environment proxy; the same as Node
 * flags in NODE_OPTIONS or execArgv, audit N-3) may be set. Chosen over a private https Agent
 * inside FragmentHttp because the refusal covers every Node request of the process (Fragment's
 * fetch now, the S8 adapter and anything after it), and a CA variable would reach an own Agent
 * too. The session key may not be the wallet key (audit I-11). Messages name variables, never
 * values.
 */
export function liveFragmentProblems(
  source: Source,
  key: FragmentKeySource,
  walletKeyText: string | undefined,
  execArgv: readonly string[] = process.execArgv,
): string[] {
  const problems = [...networkEnvRefusals(source), ...networkFlagRefusals(source, execArgv)].map(
    (refusal) => `${refusal}: refused with FULFILLMENT_DRY_RUN=false`,
  );
  if (key.key === undefined && key.problems.length === 0) {
    problems.push(
      `${FILE} (or ${INLINE} outside production): is required with FULFILLMENT_DRY_RUN=false`,
    );
  }
  if (key.key !== undefined && walletKeyText !== undefined && key.key.sameAs(walletKeyText)) {
    problems.push(`${INLINE} and WALLET_ENC_KEY: must be two different keys`);
  }
  return problems;
}

/** After the boot read (D-52 D3): the key and its file path leave the process environment. */
export function forgetFragmentSessionKey(env: NodeJS.ProcessEnv): void {
  delete env[INLINE];
  delete env[FILE];
}

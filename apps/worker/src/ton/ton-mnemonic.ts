import { mnemonicToPrivateKey, mnemonicValidate, type KeyPair } from '@ton/crypto';
import { AesGcmError, openAesGcm, parseAesKey, sealAesGcm } from '../crypto/aes-gcm';

export type TonNetwork = 'mainnet' | 'testnet';

/**
 * The AAD of the encrypted mnemonic. The network is part of it: a blob encrypted for testnet never
 * opens on mainnet (plan §11 "testnet/mainnet aralashuvi"), on top of the address check.
 */
export function tonMnemonicPurpose(network: TonNetwork): string {
  return `ggpin/ton-mnemonic/v1/${network}`;
}

export type TonSecretProblem = 'BAD_KEY' | 'BAD_BLOB' | 'BAD_MNEMONIC';

/** Why the wallet secret cannot be used. Never carries a word, the key or the blob. */
export class TonSecretError extends Error {
  constructor(readonly problem: TonSecretProblem) {
    super(
      problem === 'BAD_KEY'
        ? 'WALLET_ENC_KEY must be 32 random bytes written in base64'
        : problem === 'BAD_BLOB'
          ? 'TON_MNEMONIC_ENC cannot be opened with WALLET_ENC_KEY (wrong key, another network or a damaged blob)'
          : 'TON_MNEMONIC_ENC does not hold a valid 24-word TON mnemonic',
    );
    this.name = 'TonSecretError';
  }
}

function keyOf(keyText: string): Buffer {
  try {
    return parseAesKey(keyText);
  } catch (error) {
    if (error instanceof AesGcmError) throw new TonSecretError('BAD_KEY');
    throw error;
  }
}

/** Splits the typed phrase into words: any whitespace, lower case. Nothing else is accepted. */
export function mnemonicWords(phrase: string): string[] {
  return phrase.trim().toLowerCase().split(/\s+/);
}

/** Encrypts a mnemonic for TON_MNEMONIC_ENC (the encrypt CLI only). */
export async function sealMnemonic(
  words: readonly string[],
  keyText: string,
  network: TonNetwork,
): Promise<string> {
  if (words.length !== 24 || !(await mnemonicValidate([...words]))) {
    throw new TonSecretError('BAD_MNEMONIC');
  }
  const plain = Buffer.from(words.join(' '), 'utf8');
  try {
    return sealAesGcm(plain, keyOf(keyText), tonMnemonicPurpose(network));
  } finally {
    plain.fill(0);
  }
}

/**
 * Opens the blob only far enough to prove the key fits (boot check). The plaintext is zeroed at
 * once; the wallet opens it again when it starts.
 */
export function checkMnemonicBlob(blob: string, keyText: string, network: TonNetwork): void {
  try {
    openAesGcm(blob, keyOf(keyText), tonMnemonicPurpose(network)).fill(0);
  } catch (error) {
    if (error instanceof AesGcmError) throw new TonSecretError('BAD_BLOB');
    throw error;
  }
}

/**
 * The key pair of the hot wallet, derived in memory from the encrypted mnemonic. The plaintext
 * buffer is zeroed after use (the word strings cannot be, they are JS strings: they are dropped
 * at once and never leave this function).
 */
export async function keyPairFromBlob(
  blob: string,
  keyText: string,
  network: TonNetwork,
): Promise<KeyPair> {
  let plain: Buffer;
  try {
    plain = openAesGcm(blob, keyOf(keyText), tonMnemonicPurpose(network));
  } catch (error) {
    if (error instanceof AesGcmError) throw new TonSecretError('BAD_BLOB');
    throw error;
  }
  try {
    const words = mnemonicWords(plain.toString('utf8'));
    if (words.length !== 24 || !(await mnemonicValidate(words))) {
      throw new TonSecretError('BAD_MNEMONIC');
    }
    return await mnemonicToPrivateKey(words);
  } finally {
    plain.fill(0);
  }
}

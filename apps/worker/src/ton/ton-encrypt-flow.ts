import type { Address } from '@ton/core';
import { keyPairFromBlob, mnemonicWords, sealMnemonic, type TonNetwork } from './ton-mnemonic';
import { walletContractFor } from './ton-wallet';

// `ton:encrypt-mnemonic` (plan S5 CLI): the owner types the 24 words on a terminal (not echoed);
// the result is the TON_MNEMONIC_ENC blob (AES-256-GCM, the network in its AAD) and the W5R1
// address it derives on that network, for TON_WALLET_ADDRESS. The words are never written
// anywhere; the blob is opened again the worker's way before it is handed out, so a blob that
// would not boot is never printed.

/** The operator's terminal (prompts on stderr; stdout is the CLI's result only). */
export interface MnemonicPrompt {
  askHidden(prompt: string): Promise<string>;
}

export interface EncryptedMnemonic {
  readonly blob: string;
  /** User-friendly, non-bounceable (what wallet apps show), test-only flagged on testnet. */
  readonly address: string;
}

export function friendlyAddress(address: Address, network: TonNetwork): string {
  return address.toString({ bounceable: false, testOnly: network === 'testnet' });
}

/** Throws TonSecretError (BAD_KEY, BAD_MNEMONIC); its message never carries a word. */
export async function encryptMnemonic(
  io: MnemonicPrompt,
  keyText: string,
  network: TonNetwork,
): Promise<EncryptedMnemonic> {
  const phrase = await io.askHidden(
    `the 24 words of the ${network} hot wallet, separated by spaces (not shown): `,
  );
  const blob = await sealMnemonic(mnemonicWords(phrase), keyText, network);
  const keyPair = await keyPairFromBlob(blob, keyText, network);
  try {
    const address = walletContractFor(keyPair.publicKey, network).address;
    return { blob, address: friendlyAddress(address, network) };
  } finally {
    keyPair.secretKey.fill(0);
  }
}

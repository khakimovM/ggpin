import { inspect } from 'node:util';

// The hot wallet's key material on its way from the boot read to the wallet factory (audit L2,
// review m3). The frozen WORKER_CONFIG lives as long as the process and is injected into many
// services, so it does not carry the encrypted mnemonic and its AES key as two plain strings (the
// pair opens the mnemonic): it carries this one-shot handle. The wallet factory takes the pair
// ONCE, opens the wallet and drops it; after that the handle is empty. It prints and serializes
// as a placeholder, so a logged or inspected config shows nothing of either value.

export interface WalletSecretMaterial {
  /** TON_MNEMONIC_ENC: the AES-256-GCM blob of the mnemonic. */
  readonly mnemonicBlob: string;
  /** WALLET_ENC_KEY: the key text (from WALLET_ENC_KEY_FILE in production). */
  readonly keyText: string;
}

export class WalletSecretHandle {
  #material: WalletSecretMaterial | null;

  constructor(material: WalletSecretMaterial) {
    this.#material = material;
  }

  /** The key material, once: every later call gets null (the wallet is opened only once). */
  take(): WalletSecretMaterial | null {
    const material = this.#material;
    this.#material = null;
    return material;
  }

  get taken(): boolean {
    return this.#material === null;
  }

  toJSON(): string {
    return '[wallet secret]';
  }

  [inspect.custom](): string {
    return 'WalletSecretHandle([redacted])';
  }
}

import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { keyPairFromSeed, type KeyPair } from '@ton/crypto';
import {
  SendMode,
  beginCell,
  external,
  internal,
  storeMessage,
  type Address,
  type Cell,
} from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';
import { hashHex, parseTonAddress, rawAddress } from './ton-address';
import { keyPairFromBlob, type TonNetwork } from './ton-mnemonic';
import { normalizedExternalHash } from './ton-tx-scan';
import { parseW5Data, type W5Data } from './ton-w5';

// The hot wallet (W5R1) of the worker. The secret key lives only in this object's private field,
// in memory (rules/60); the object prints and serializes as its address only. Signing never logs
// and never returns the key; the signed message is returned as a BOC to be stored BEFORE it is
// broadcast (rules/45 step 5).

/** W5R1 binds the network into the wallet id, so one key has a different address per network. */
export const TON_NETWORK_GLOBAL_ID: Readonly<Record<TonNetwork, number>> = {
  mainnet: -239,
  testnet: -3,
};

export function walletContractFor(
  publicKey: Buffer,
  network: TonNetwork,
  subwalletNumber = 0,
): WalletContractV5R1 {
  return WalletContractV5R1.create({
    publicKey,
    walletId: {
      networkGlobalId: TON_NETWORK_GLOBAL_ID[network],
      context: { walletVersion: 'v5r1', workchain: 0, subwalletNumber },
    },
  });
}

export interface TransferToSign {
  readonly seqno: number;
  /** `valid_until` of the message, unix seconds (chain time). */
  readonly validUntilSec: number;
  readonly to: Address;
  readonly amountNano: bigint;
  /** The message body (Fragment's payload); its cell hash is stored as `payloadHash`. */
  readonly body: Cell;
  readonly bounce: boolean;
  /** The wallet is not deployed yet: the message carries its StateInit. */
  readonly deploy: boolean;
  /**
   * Testnet self-test only: the StateInit of the destination (our own second wallet), so the value
   * deploys it on arrival instead of being aborted at an empty account. Payouts never set it.
   */
  readonly destinationInit?: { readonly code: Cell; readonly data: Cell };
}

export interface SignedTransfer {
  readonly boc: Buffer;
  readonly bocBase64: string;
  readonly extMsgHash: string;
  readonly payloadHash: string;
}

export class TonWallet {
  readonly address: Address;
  readonly rawAddress: string;
  /** The wallet's init data (seqno 0): public key and wallet id the chain state must show. */
  readonly own: W5Data;
  readonly #secretKey: Buffer;
  readonly #contract: WalletContractV5R1;

  constructor(
    keyPair: KeyPair,
    readonly network: TonNetwork,
    /** True for the throw-away key of a dry run: only the fake chain knows it. */
    readonly dryRun: boolean,
  ) {
    this.#secretKey = Buffer.from(keyPair.secretKey);
    this.#contract = walletContractFor(keyPair.publicKey, network);
    this.address = this.#contract.address;
    this.rawAddress = rawAddress(this.address);
    this.own = parseW5Data(this.#contract.init.data);
  }

  /** The StateInit of the wallet (the fake chain deploys it). */
  get init(): { readonly code: Cell; readonly data: Cell } {
    return this.#contract.init;
  }

  /** Signs one transfer as an external message. Pure: nothing is sent or stored here. */
  sign(transfer: TransferToSign): SignedTransfer {
    if (!Number.isInteger(transfer.seqno) || transfer.seqno < 0 || transfer.seqno > 0xffff_ffff) {
      throw new RangeError('seqno must be a 32-bit unsigned integer');
    }
    if (!Number.isInteger(transfer.validUntilSec) || transfer.validUntilSec <= 0) {
      throw new RangeError('validUntilSec must be a positive unix time');
    }
    if (transfer.amountNano <= 0n) throw new RangeError('the amount must be positive');
    const body = this.#contract.createTransfer({
      seqno: transfer.seqno,
      secretKey: this.#secretKey,
      timeout: transfer.validUntilSec,
      // Fees are paid on top, so the message carries exactly the amount; +2 is what a W5 external
      // message must carry anyway (a failed send is skipped, not retried).
      sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
      messages: [
        internal({
          to: transfer.to,
          value: transfer.amountNano,
          bounce: transfer.bounce,
          body: transfer.body,
          ...(transfer.destinationInit === undefined ? {} : { init: transfer.destinationInit }),
        }),
      ],
    });
    const message = external({
      to: this.address,
      init: transfer.deploy ? this.#contract.init : null,
      body,
    });
    const boc = beginCell().store(storeMessage(message)).endCell().toBoc();
    return {
      boc,
      bocBase64: boc.toString('base64'),
      extMsgHash: normalizedExternalHash(message),
      payloadHash: hashHex(transfer.body.hash()),
    };
  }

  toJSON(): { readonly network: TonNetwork; readonly address: string } {
    return { network: this.network, address: this.rawAddress };
  }

  [inspect.custom](): string {
    return `TonWallet(${this.network} ${this.rawAddress})`;
  }
}

export type TonWalletProblem = 'MISSING_SECRET' | 'ADDRESS_MISMATCH';

/** Why the wallet does not open. Never carries a word, a key or the blob. */
export class TonWalletError extends Error {
  constructor(readonly problem: TonWalletProblem) {
    super(
      problem === 'MISSING_SECRET'
        ? 'the TON wallet needs TON_MNEMONIC_ENC, WALLET_ENC_KEY(_FILE) and TON_WALLET_ADDRESS'
        : 'TON_WALLET_ADDRESS is not the W5R1 wallet the mnemonic derives on TON_NETWORK: boot refused',
    );
    this.name = 'TonWalletError';
  }
}

export interface OpenWalletInput {
  readonly network: TonNetwork;
  readonly mnemonicBlob: string | undefined;
  readonly keyText: string | undefined;
  readonly expectedAddress: string | undefined;
}

/**
 * Opens the real hot wallet in memory: decrypts the mnemonic, derives the key, and refuses unless
 * the derived address IS `TON_WALLET_ADDRESS` (plan S5: the boot stops on a mismatch).
 */
export async function openTonWallet(input: OpenWalletInput): Promise<TonWallet> {
  const { mnemonicBlob, keyText, expectedAddress } = input;
  if (mnemonicBlob === undefined || keyText === undefined || expectedAddress === undefined) {
    throw new TonWalletError('MISSING_SECRET');
  }
  const expected = parseTonAddress(expectedAddress, 'TON_WALLET_ADDRESS');
  const keyPair = await keyPairFromBlob(mnemonicBlob, keyText, input.network);
  try {
    const wallet = new TonWallet(keyPair, input.network, false);
    if (!wallet.address.equals(expected)) throw new TonWalletError('ADDRESS_MISMATCH');
    return wallet;
  } finally {
    keyPair.secretKey.fill(0);
  }
}

/**
 * The dry-run wallet: a random key made for this process, never funded, known only to the fake
 * chain of this process (plan §8: no wallet secret is read in a dry run).
 */
export function dryRunTonWallet(network: TonNetwork): TonWallet {
  const seed = randomBytes(32);
  const keyPair = keyPairFromSeed(seed);
  try {
    return new TonWallet(keyPair, network, true);
  } finally {
    seed.fill(0);
    keyPair.secretKey.fill(0);
  }
}

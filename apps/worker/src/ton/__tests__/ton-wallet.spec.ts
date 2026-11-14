import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { mnemonicNew } from '@ton/crypto';
import { Address, Cell, beginCell, loadMessage } from '@ton/core';
import { rawAddress } from '../ton-address';
import { keyPairFromBlob, sealMnemonic, TonSecretError } from '../ton-mnemonic';
import { normalizedExternalHash } from '../ton-tx-scan';
import { buildW5Data, parseW5Data } from '../ton-w5';
import {
  dryRunTonWallet,
  openTonWallet,
  TonWalletError,
  walletContractFor,
  type TonWallet,
} from '../ton-wallet';

// Test material is made per run (gitleaks: no mnemonic or key in the source): a fresh mnemonic of
// @ton/crypto, a random AES key, the blob of the two.

let words: string[];
let key: string;
let blob: string;
let publicKey: Buffer;
let secretHex: string;
let wallet: TonWallet;

beforeAll(async () => {
  words = await mnemonicNew(24);
  key = randomBytes(32).toString('base64');
  blob = await sealMnemonic(words, key, 'testnet');
  const pair = await keyPairFromBlob(blob, key, 'testnet');
  publicKey = Buffer.from(pair.publicKey);
  secretHex = Buffer.from(pair.secretKey).toString('hex');
  const expected = walletContractFor(publicKey, 'testnet').address.toRawString();
  wallet = await openTonWallet({
    network: 'testnet',
    mnemonicBlob: blob,
    keyText: key,
    expectedAddress: expected,
  });
}, 60_000);

function leakFree(text: string): void {
  expect(text).not.toContain(secretHex.slice(0, 32));
  expect(text).not.toContain(blob.slice(0, 24));
  expect(text).not.toContain(key.slice(0, 16));
  // Pairs of neighbouring words: a single word ("wallet", "network") may be ordinary English.
  for (let i = 0; i + 1 < words.length; i += 1) {
    expect(text).not.toContain(`${words[i] ?? ''} ${words[i + 1] ?? ''}`);
  }
}

describe('TonWallet (W5R1, plan S5)', () => {
  it('opens only when the mnemonic derives TON_WALLET_ADDRESS on TON_NETWORK', async () => {
    expect(wallet.rawAddress).toBe(rawAddress(walletContractFor(publicKey, 'testnet').address));
    // One key, two networks, two addresses (the network id is in the W5 wallet id).
    expect(walletContractFor(publicKey, 'mainnet').address.equals(wallet.address)).toBe(false);
    const other = new Address(0, randomBytes(32)).toRawString();
    const open = (expectedAddress: string | undefined) =>
      openTonWallet({ network: 'testnet', mnemonicBlob: blob, keyText: key, expectedAddress });
    await expect(open(other)).rejects.toMatchObject({ problem: 'ADDRESS_MISMATCH' });
    await expect(open(undefined)).rejects.toMatchObject({ problem: 'MISSING_SECRET' });
    // The friendly form of the right address is the same wallet.
    const friendly = wallet.address.toString({ testOnly: true, bounceable: false });
    expect((await open(friendly)).rawAddress).toBe(wallet.rawAddress);
  });

  it('a testnet blob never opens on mainnet (the network is in the AAD)', async () => {
    const expected = walletContractFor(publicKey, 'mainnet').address.toRawString();
    await expect(
      openTonWallet({
        network: 'mainnet',
        mnemonicBlob: blob,
        keyText: key,
        expectedAddress: expected,
      }),
    ).rejects.toMatchObject({ problem: 'BAD_BLOB' });
  });

  it('prints, serializes and fails without the key, the words or the blob (redaction)', async () => {
    expect(JSON.parse(JSON.stringify(wallet))).toEqual({
      network: 'testnet',
      address: wallet.rawAddress,
    });
    expect(inspect(wallet)).toBe(`TonWallet(testnet ${wallet.rawAddress})`);
    leakFree(inspect(wallet, { showHidden: true, depth: 10 }));
    leakFree(`${JSON.stringify({ wallet })} ${String(Object.keys(wallet))}`);
    const errors = await Promise.all([
      openTonWallet({
        network: 'testnet',
        mnemonicBlob: blob,
        keyText: randomBytes(32).toString('base64'),
        expectedAddress: wallet.rawAddress,
      }).catch((e: unknown) => e),
      openTonWallet({
        network: 'testnet',
        mnemonicBlob: blob,
        keyText: key,
        expectedAddress: new Address(0, randomBytes(32)).toRawString(),
      }).catch((e: unknown) => e),
      sealMnemonic(words.slice(1), key, 'testnet').catch((e: unknown) => e),
    ]);
    for (const error of errors) {
      expect(error instanceof TonSecretError || error instanceof TonWalletError).toBe(true);
      leakFree(`${String(error)} ${inspect(error)} ${JSON.stringify(error)}`);
    }
  });

  it('reads the W5R1 data layout exactly as the library writes it', () => {
    const contract = walletContractFor(publicKey, 'testnet');
    const data = parseW5Data(contract.init.data);
    expect(data.publicKey.equals(publicKey)).toBe(true);
    expect(data.seqno).toBe(0);
    expect(data.signatureAllowed).toBe(true);
    expect(buildW5Data(data, 0).hash().equals(contract.init.data.hash())).toBe(true);
    expect(wallet.own).toEqual(data);
  });

  it('signs one external message: hashes of what is stored, StateInit only when asked', () => {
    const to = new Address(0, randomBytes(32));
    const body = beginCell().storeUint(0, 32).storeStringTail('payload').endCell();
    const base = {
      seqno: 3,
      validUntilSec: 1_900_000_000,
      to,
      amountNano: 10n ** 9n,
      body,
      bounce: true,
      deploy: false,
    };
    const signed = wallet.sign(base);
    const message = loadMessage(
      Cell.fromBoc(signed.boc)[0]?.beginParse() ?? Cell.EMPTY.beginParse(),
    );
    expect(message.info.type).toBe('external-in');
    expect(message.info.dest?.toString()).toBe(wallet.address.toString());
    expect(message.init ?? null).toBeNull();
    expect(signed.extMsgHash).toBe(normalizedExternalHash(message));
    expect(signed.payloadHash).toBe(body.hash().toString('hex'));
    expect(Buffer.from(signed.bocBase64, 'base64').equals(signed.boc)).toBe(true);
    expect(wallet.sign({ ...base, deploy: true }).boc.equals(signed.boc)).toBe(false);
    const deploy = loadMessage(
      Cell.fromBoc(wallet.sign({ ...base, deploy: true }).boc)[0]?.beginParse() ??
        Cell.EMPTY.beginParse(),
    );
    expect(deploy.init?.code?.hash().equals(wallet.init.code.hash())).toBe(true);
    for (const bad of [
      { seqno: -1 },
      { seqno: 2 ** 32 },
      { validUntilSec: 0 },
      { amountNano: 0n },
    ]) {
      expect(() => wallet.sign({ ...base, ...bad })).toThrow(RangeError);
    }
  });

  it('the dry-run wallet is a throw-away key of this process', () => {
    const a = dryRunTonWallet('testnet');
    const b = dryRunTonWallet('testnet');
    expect(a.dryRun).toBe(true);
    expect(wallet.dryRun).toBe(false);
    expect(a.rawAddress).not.toBe(b.rawAddress);
  });
});

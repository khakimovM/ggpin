import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { Address } from '@ton/core';
import { mnemonicNew } from '@ton/crypto';
import { encryptMnemonic, friendlyAddress } from '../ton-encrypt-flow';
import { keyPairFromBlob, TonSecretError } from '../ton-mnemonic';
import { walletContractFor } from '../ton-wallet';

// The words are generated per run (gitleaks: never a mnemonic in the source).

let words: string[];
const key = randomBytes(32).toString('base64');
const prompt = (phrase: string) => ({ askHidden: () => Promise.resolve(phrase) });

beforeAll(async () => {
  words = await mnemonicNew(24);
}, 60_000);

describe('ton:encrypt-mnemonic flow', () => {
  it('returns only the blob and the address, and the blob opens the worker way', async () => {
    // Typed with stray spaces and capitals: normalised before sealing.
    const typed = `  ${words.join('   ').toUpperCase()} `;
    const result = await encryptMnemonic(prompt(typed), key, 'testnet');
    expect(Object.keys(result).sort()).toEqual(['address', 'blob']);
    const pair = await keyPairFromBlob(result.blob, key, 'testnet');
    const expected = walletContractFor(Buffer.from(pair.publicKey), 'testnet').address;
    expect(result.address).toBe(friendlyAddress(expected, 'testnet'));
    const parsed = Address.parseFriendly(result.address);
    expect([parsed.isTestOnly, parsed.isBounceable]).toEqual([true, false]);
    const printed = `${JSON.stringify(result)} ${inspect(result)}`;
    for (let i = 0; i + 1 < words.length; i += 1) {
      expect(printed.toLowerCase()).not.toContain(`${words[i] ?? ''} ${words[i + 1] ?? ''}`);
    }
    // A mainnet blob of the same words is another blob for another address.
    const mainnet = await encryptMnemonic(prompt(words.join(' ')), key, 'mainnet');
    expect(mainnet.address).not.toBe(result.address);
    expect(Address.parseFriendly(mainnet.address).isTestOnly).toBe(false);
  });

  it('refuses a short or invalid phrase and a bad key, with no word in the message', async () => {
    const failure = (phrase: string, keyText = key) =>
      encryptMnemonic(prompt(phrase), keyText, 'testnet').then(
        () => null,
        (e: unknown) => e,
      );
    const short = await failure(words.slice(0, 23).join(' '));
    expect(short).toBeInstanceOf(TonSecretError);
    expect(short).toMatchObject({ problem: 'BAD_MNEMONIC' });
    expect(String(short)).not.toContain(words.slice(0, 2).join(' '));
    expect(await failure(Array.from({ length: 24 }, () => 'notaword').join(' '))).toMatchObject({
      problem: 'BAD_MNEMONIC',
    });
    expect(await failure(words.join(' '), 'c2hvcnQ=')).toMatchObject({ problem: 'BAD_KEY' });
  });
});

import { EnvValidationError } from '../config/env';
import { loadTonKeyEnv } from '../config/ton-cli-env';
import { errorKind } from '../ton/ton-db-errors';
import { encryptMnemonic } from '../ton/ton-encrypt-flow';
import { TonSecretError } from '../ton/ton-mnemonic';
import { createTtyIo } from './tty-io';

// Encrypts the hot wallet mnemonic for TON_MNEMONIC_ENC (plan S5, D-56). Run it where the worker
// runs, in an interactive terminal, with WALLET_ENC_KEY_FILE (or WALLET_ENC_KEY outside
// production) and TON_NETWORK set:
//   npm run -s ton:encrypt-mnemonic -w worker > ton-wallet.env
// `-s`: without it npm writes its own banner to stdout, into the result. The words are typed on
// the terminal and never echoed, logged or written; stderr gets the prompts, stdout ONLY the two
// lines TON_MNEMONIC_ENC=... and TON_WALLET_ADDRESS=... . Compare the address with the wallet app,
// move both lines into the secret store and delete the file.

async function main(): Promise<number> {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
    process.stderr.write('ton-encrypt-mnemonic: needs an interactive terminal (TTY); refused\n');
    return 2;
  }
  const env = loadTonKeyEnv();
  const io = createTtyIo(process.stdin, process.stderr);
  try {
    const result = await encryptMnemonic(io, env.key, env.network);
    process.stdout.write(`TON_MNEMONIC_ENC=${result.blob}\nTON_WALLET_ADDRESS=${result.address}\n`);
    io.say(`done (${env.network}): compare TON_WALLET_ADDRESS with the wallet app before use`);
    return 0;
  } catch (error) {
    const reason = error instanceof TonSecretError ? error.message : errorKind(error);
    io.say(`ton-encrypt-mnemonic: ${reason}`);
    return 1;
  } finally {
    io.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const readable = error instanceof EnvValidationError || error instanceof TonSecretError;
    process.stderr.write(`ton-encrypt-mnemonic: ${readable ? error.message : errorKind(error)}\n`);
    process.exit(2);
  },
);

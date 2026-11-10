import { parseSessionKey, SessionCryptoError } from '../bank-feed/client/session-crypto';
import { adaptLogin, createTelegram, loadMtcute } from '../bank-feed/client/mtcute-loader';
import { errorCode } from '../bank-feed/client/mtcute-types';
import { loadLoginEnv } from '../config/bank-feed-login-env';
import { EnvValidationError } from '../config/env';
import { LoginError, runLogin } from './login-flow';
import { createTtyIo } from './tty-io';

// Login of the bank-feed working account (docs/05 §4 runbook, plan S7). Run it on the VPS in the
// worker container, with the owner present (D-37 (14)), in an interactive terminal:
//   npm run -s bank-feed:login -w worker > session.blob
// `-s` (silent): without it npm writes its own "> worker@ bank-feed:login" banner to stdout, into
// the blob (D-52 r2, review I-6). Prompts go to stderr; stdout gets ONLY the AES-256-GCM blob for
// BANK_FEED_SESSION_ENC; delete session.blob once its content is in the secret store. The
// plaintext session is kept in memory only and written nowhere. The client is destroyed WITHOUT
// logging out, so the exported session stays valid. Never run it against a real account from a
// development machine (E-20).

async function main(): Promise<number> {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
    process.stderr.write('bank-feed-login: needs an interactive terminal (TTY); refused\n');
    return 2;
  }
  const env = loadLoginEnv();
  const key = parseSessionKey(env.BANK_FEED_ENC_KEY);
  const io = createTtyIo(process.stdin, process.stderr);
  const telegram = adaptLogin(
    createTelegram(await loadMtcute(), {
      apiId: env.BANK_FEED_API_ID,
      apiHash: env.BANK_FEED_API_HASH,
    }),
  );
  try {
    const blob = await runLogin(telegram, io, key);
    process.stdout.write(`${blob}\n`);
    io.say('done: put the line printed on stdout into BANK_FEED_SESSION_ENC');
    return 0;
  } catch (error) {
    io.say(`bank-feed-login: ${error instanceof LoginError ? error.message : errorCode(error)}`);
    return 1;
  } finally {
    io.close();
    await telegram.destroy().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const readable = error instanceof EnvValidationError || error instanceof SessionCryptoError;
    process.stderr.write(`bank-feed-login: ${readable ? error.message : errorCode(error)}\n`);
    process.exit(2);
  },
);

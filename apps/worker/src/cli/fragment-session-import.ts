import { createPrismaClient } from '@repo/db';
import { FragmentSessionStore } from '../adapters/fragment/fragment-session.store';
import { CookieInputError } from '../adapters/fragment/fragment-cookie-jar';
import { EnvValidationError } from '../config/env';
import { loadFragmentImportEnv } from '../config/fragment-import-env';
import { errorKind } from '../ton/ton-db-errors';
import { importFragmentSession } from './fragment-session-import-flow';
import { createTtyIo } from './tty-io';

// Imports the Fragment browser session (Q9, phase 5 S7, docs/06 "Fragment sessiyasi"). Run it
// where the worker runs, with DATABASE_URL and FRAGMENT_SESSION_ENC_KEY_FILE (or the inline key
// outside production) set. The cookies come on stdin ONLY. The normal way is interactive: run
//   npm run -s fragment:session-import -w worker
// and paste the browser's Cookie header at the prompt (hidden: not echoed, never on disk). A file
// on stdin works too (`... < /path/outside/the/repo/fragment-cookies.txt`), but only from OUTSIDE
// the repository, deleted right after (audit I-3; `.gitignore` refuses `*cookies*.txt` and
// gitleaks flags `stel_ssid=`/`stel_token=` as a second line). Lines `name=value` or `a=1; b=2`.
// Prompts and results go to stderr; nothing of a value is printed or logged. The key's fingerprint
// (8 hex, audit L-4) is printed: the worker logs the same at boot when both use the same key.

const MAX_INPUT_BYTES = 64 * 1024;

async function readPiped(stream: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_INPUT_BYTES) throw new CookieInputError('the input is too long');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readCookies(): Promise<string> {
  if (process.stdin.isTTY !== true) return readPiped(process.stdin);
  const io = createTtyIo(process.stdin, process.stderr);
  try {
    return await io.askHidden('paste the fragment.com Cookie header (not shown): ');
  } finally {
    io.close();
  }
}

async function main(): Promise<number> {
  const env = loadFragmentImportEnv();
  const input = await readCookies();
  const client = createPrismaClient(env.DATABASE_URL);
  const say = (line: string) => process.stderr.write(`fragment-session-import: ${line}\n`);
  say(`session key fingerprint ${env.key.fingerprint()}`);
  try {
    await importFragmentSession(input, new FragmentSessionStore({ client }, env.key), say);
    return 0;
  } finally {
    await client.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const readable = error instanceof EnvValidationError || error instanceof CookieInputError;
    process.stderr.write(
      `fragment-session-import: ${readable ? error.message : errorKind(error)}\n`,
    );
    process.exit(2);
  },
);

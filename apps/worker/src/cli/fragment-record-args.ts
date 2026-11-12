import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseTonAddress } from '../adapters/fragment/ton-address-forms';

// Arguments of `fragment:record` (plan S0b + fix rounds). Error messages name options, never
// values: the inputs are a live session and personal data. The tool never writes into a repo:
// raw responses go to --out, sanitized copies to the --fixtures staging folder (both checked
// when the folders are prepared).

export interface FragmentRecordArgs {
  readonly cookiesFile: string;
  readonly username: string;
  /** Raw responses (default ~/Desktop/ggpin-secrets/fragment-raw/<time>). */
  readonly outDir: string;
  /** Sanitized copies for review (default ~/Desktop/ggpin-fixtures-staging/<time>, R-3). */
  readonly fixturesDir: string;
  readonly confirmNoPayment: boolean;
  readonly recipientAgeCheck: boolean;
  readonly tonConnectFile: string | null;
  readonly redactFile: string | null;
  /** Always required (N10): only a known id is redacted everywhere. */
  readonly telegramId: string;
  /** The owner's wallet, for redaction only (S-3); required with --confirm-no-payment (R-4). */
  readonly wallet: string | null;
  /** The owner's display name(s), for redaction only (R-2). */
  readonly names: string[];
  /** The owner's phone number(s), for redaction only (R-9). */
  readonly phones: string[];
}

export const FRAGMENT_RECORD_USAGE =
  'usage: fragment-record --cookies <file> --username <your @username> --telegram-id <digits> ' +
  '[--confirm-no-payment --wallet <address> --name <your name>] [--name ...] [--phone ...] ' +
  '[--recipient-age-check] [--out <dir>] [--fixtures <dir>] [--ton-connect <file>] ' +
  '[--redact <file>]';

export class RecordUsageError extends Error {
  constructor(reason: string) {
    super(`${reason}\n${FRAGMENT_RECORD_USAGE}`);
    this.name = 'RecordUsageError';
  }
}

export interface ArgsContext {
  readonly home: string;
  readonly cwd: string;
  readonly now: Date;
}

const USERNAME_RE = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/;

const stamp = (ctx: ArgsContext): string => ctx.now.toISOString().replace(/[:.]/g, '-');

function readValues(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        cookies: { type: 'string' },
        username: { type: 'string' },
        out: { type: 'string' },
        fixtures: { type: 'string' },
        'ton-connect': { type: 'string' },
        redact: { type: 'string' },
        'telegram-id': { type: 'string' },
        wallet: { type: 'string' },
        name: { type: 'string', multiple: true },
        phone: { type: 'string', multiple: true },
        'confirm-no-payment': { type: 'boolean', default: false },
        'recipient-age-check': { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new RecordUsageError('unknown or malformed option');
  }
}

export function parseFragmentRecordArgs(
  argv: readonly string[],
  ctx: ArgsContext,
): FragmentRecordArgs {
  const values = readValues(argv);
  if (values.cookies === undefined || values.cookies.trim() === '') {
    throw new RecordUsageError('--cookies is required');
  }
  const username = USERNAME_RE.exec(values.username ?? '')?.[1];
  if (username === undefined) throw new RecordUsageError('--username must be a Telegram username');
  const telegramId = values['telegram-id'];
  if (telegramId === undefined) {
    throw new RecordUsageError(
      '--telegram-id is required (your numeric Telegram id, to redact it)',
    );
  }
  if (!/^\d{5,15}$/.test(telegramId)) throw new RecordUsageError('--telegram-id must be digits');
  const confirmNoPayment = values['confirm-no-payment'] === true;
  const recipientAgeCheck = values['recipient-age-check'] === true;
  if (recipientAgeCheck && !confirmNoPayment) {
    throw new RecordUsageError('--recipient-age-check needs --confirm-no-payment');
  }
  const wallet = values.wallet ?? null;
  if (wallet !== null && parseTonAddress(wallet) === null) {
    throw new RecordUsageError('--wallet is not a TON address');
  }
  const names = (values.name ?? []).map((n) => n.trim());
  if (names.some((n) => [...n].length < 3)) throw new RecordUsageError('--name is too short');
  const phones = (values.phone ?? []).map((p) => p.trim());
  if (phones.some((p) => p.replace(/\D/g, '').length < 7)) {
    throw new RecordUsageError('--phone needs at least 7 digits');
  }
  // R-4: without the owner's wallet, a wallet in the link step could pass as Fragment's.
  if (confirmNoPayment && wallet === null) {
    throw new RecordUsageError('--confirm-no-payment needs --wallet (your wallet, to redact it)');
  }
  // R-2: the name too; --redact text lines also count (checked once the file is read).
  if (confirmNoPayment && names.length === 0 && values.redact === undefined) {
    throw new RecordUsageError(
      '--confirm-no-payment needs --name (your display name, to redact it)',
    );
  }
  // F-3: the phone too (a --redact phone line also counts, checked once the file is read).
  if (confirmNoPayment && phones.length === 0 && values.redact === undefined) {
    throw new RecordUsageError(
      '--confirm-no-payment needs --phone (your phone number, to redact it)',
    );
  }
  const resolve = (value: string | undefined): string | null =>
    value === undefined ? null : path.resolve(ctx.cwd, value);
  const desktop = path.join(ctx.home, 'Desktop');
  return {
    cookiesFile: path.resolve(ctx.cwd, values.cookies),
    username,
    outDir: resolve(values.out) ?? path.join(desktop, 'ggpin-secrets', 'fragment-raw', stamp(ctx)),
    fixturesDir:
      resolve(values.fixtures) ?? path.join(desktop, 'ggpin-fixtures-staging', stamp(ctx)),
    confirmNoPayment,
    recipientAgeCheck,
    tonConnectFile: resolve(values['ton-connect']),
    redactFile: resolve(values.redact),
    telegramId,
    wallet,
    names,
    phones,
  };
}

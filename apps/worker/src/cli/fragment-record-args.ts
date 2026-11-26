import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseTonAddress } from '../adapters/fragment/ton-address-forms';
import { assertLocalForm } from './fragment-record-paths';

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
  /** An account that already has Premium, searched once (P6-S0a, Q10); null when not given. */
  readonly premiumHolder: string | null;
  /** That account's display name(s), for redaction only; required with --premium-holder. */
  readonly premiumHolderNames: string[];
}

export const FRAGMENT_RECORD_USAGE =
  'usage: fragment-record --cookies <file> --username <your @username> --telegram-id <digits> ' +
  '[--confirm-no-payment --wallet <address> --name <your name>] [--name ...] [--phone ...] ' +
  '[--premium-holder <username> --premium-holder-name <their name>] ' +
  '[--premium-holder-name ...] [--recipient-age-check] [--out <dir>] [--fixtures <dir>] ' +
  '[--ton-connect <file>] [--redact <file>]';

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
        'premium-holder': { type: 'string' },
        'premium-holder-name': { type: 'string', multiple: true },
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

/**
 * --premium-holder and its --premium-holder-name values (P6-S0a): a person who agreed (Q10), so
 * their name must be known to be redacted, as the owner's (R-2); it is checked against the answer.
 */
function premiumHolderArgs(
  rawHolder: string | undefined,
  rawNames: string[] | undefined,
  owner: string,
): Pick<FragmentRecordArgs, 'premiumHolder' | 'premiumHolderNames'> {
  const premiumHolderNames = (rawNames ?? []).map((n) => n.trim());
  if (rawHolder === undefined) {
    if (premiumHolderNames.length > 0) {
      throw new RecordUsageError('--premium-holder-name needs --premium-holder');
    }
    return { premiumHolder: null, premiumHolderNames };
  }
  const premiumHolder = USERNAME_RE.exec(rawHolder)?.[1];
  if (premiumHolder === undefined) {
    throw new RecordUsageError('--premium-holder must be a Telegram username');
  }
  if (premiumHolder.toLowerCase() === owner.toLowerCase()) {
    throw new RecordUsageError('--premium-holder must be another account than --username');
  }
  if (premiumHolderNames.length === 0) {
    throw new RecordUsageError(
      '--premium-holder needs --premium-holder-name (their display name, to redact it)',
    );
  }
  if (premiumHolderNames.some((n) => [...n].length < 3)) {
    throw new RecordUsageError('--premium-holder-name is too short');
  }
  return { premiumHolder, premiumHolderNames };
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
  // R-2, M-1: the name too, always as --name (a --redact line is not checked against answers).
  if (confirmNoPayment && names.length === 0) {
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
  const holder = premiumHolderArgs(
    values['premium-holder'],
    values['premium-holder-name'],
    username,
  );
  // Every string a path is built from is checked BEFORE it is joined or resolved: off Windows,
  // `path.resolve`/`path.join` erase a UNC/device form (`//h/s` becomes `/h/s`). That covers the
  // value, the cwd it is resolved against and the home the defaults live in (a UNC cwd or home
  // makes a plain value or a default a network path), and the result once more. All are string
  // checks, so a refusal here touches no file system (fragment-record-paths.ts, assertLocalForm).
  const checked = (option: string, value: string): string => {
    assertLocalForm(value, option);
    return value;
  };
  const local = (option: string, value: string): string => {
    checked(option, value);
    if (!path.isAbsolute(value)) checked(option, ctx.cwd);
    return checked(option, path.resolve(ctx.cwd, value));
  };
  const resolve = (option: string, value: string | undefined): string | null =>
    value === undefined ? null : local(option, value);
  const byDefault = (option: string, ...parts: string[]): string =>
    checked(option, path.join(checked(option, ctx.home), 'Desktop', ...parts));
  return {
    ...holder,
    cookiesFile: local('--cookies', values.cookies),
    username,
    outDir:
      resolve('--out', values.out) ??
      byDefault('--out', 'ggpin-secrets', 'fragment-raw', stamp(ctx)),
    fixturesDir:
      resolve('--fixtures', values.fixtures) ??
      byDefault('--fixtures', 'ggpin-fixtures-staging', stamp(ctx)),
    confirmNoPayment,
    recipientAgeCheck,
    tonConnectFile: resolve('--ton-connect', values['ton-connect']),
    redactFile: resolve('--redact', values.redact),
    telegramId,
    wallet,
    names,
    phones,
  };
}

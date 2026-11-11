import type { INestApplicationContext } from '@nestjs/common';
import { parseSignedMajor, somToTiyin, tiyinToSom } from '@repo/shared';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { OtpAnswer, OwnerOtpAction } from '../../common/admin/owner-otp/owner-otp';
import { OwnerOtpIssuer } from '../../common/admin/owner-otp/owner-otp.issuer';
import { APP_CONFIG, type AppConfig } from '../../config/config.module';
import type { CardAdminActor } from '../../modules/payments/card-admin.input';
import { terminalSafe, type CliIo } from '../cli-io';
import type { CliSession } from '../cli-session';

export interface CliContext {
  readonly app: INestApplicationContext;
  readonly io: CliIo;
  /** Who runs the process (the SSH client, the OS account): read once at start. */
  readonly session: CliSession;
}

export interface CliCommand {
  readonly name: string;
  /** One line for the command list. */
  readonly summary: string;
  /** Full usage, printed by `help <command>` and on a usage error. */
  readonly usage: string;
  run(ctx: CliContext, argv: readonly string[]): Promise<void>;
}

/** A wrong flag, a missing value or a bad number: printed with the command's usage, exit 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

type Options = NonNullable<ParseArgsConfig['options']>;

/** Every changing command: who runs it and why (AuditLog.after.operator, AuditLog.reason). */
export const ACTOR_OPTIONS = {
  reason: { type: 'string' },
  operator: { type: 'string' },
  ip: { type: 'string' },
} as const satisfies Options;

export const ACTOR_USAGE =
  '--reason <text> --operator <name> [--ip <address>, only without SSH: SSH_CONNECTION wins]';

export interface Parsed {
  readonly values: Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;
  readonly positionals: readonly string[];
}

/** Strict: an unknown flag or a missing value is a usage error, never silently ignored. */
export function parse(argv: readonly string[], options: Options, positionals: number): Parsed {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: [...argv], options, strict: true, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'bad arguments');
  }
  if (parsed.positionals.length !== positionals) {
    throw new UsageError(`expected ${String(positionals)} argument(s)`);
  }
  return { values: parsed.values, positionals: parsed.positionals };
}

export function positional(p: Parsed, index: number): string {
  const value = p.positionals[index];
  if (value === undefined) throw new UsageError('missing argument');
  return value;
}

export function text(p: Parsed, name: string): string | undefined {
  const value = p.values[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new UsageError(`--${name} needs a value`);
  return value;
}

export function required(p: Parsed, name: string): string {
  const value = text(p, name);
  if (value === undefined || value === '') throw new UsageError(`--${name} is required`);
  return value;
}

export function flag(p: Parsed, name: string): boolean {
  return p.values[name] === true;
}

/**
 * --reason and --operator are required; the services check their shape. The address is the SSH
 * client's when there is one (S8-L5): a typed --ip cannot replace it, and a different one is
 * refused so a wrong audit line is never written. The OS account always goes with it.
 */
export function actorOf(ctx: CliContext, p: Parsed): { reason: string; actor: CardAdminActor } {
  const typed = text(p, 'ip');
  const ssh = ctx.session.sshIp;
  if (ssh !== null && typed !== undefined && typed !== ssh) {
    throw new UsageError('--ip differs from the SSH client address; leave it out');
  }
  const ip = ssh ?? typed;
  return {
    reason: required(p, 'reason'),
    actor: {
      operator: required(p, 'operator'),
      ...(ip === undefined ? {} : { ip }),
      osUser: ctx.session.osUser,
    },
  };
}

/** "50000" or "50000.50" so'm -> tiyin (BigInt, never a float). */
export function somAmount(value: string, name: string, signed = false): bigint {
  try {
    return signed ? parseSignedMajor('UZS', value) : somToTiyin(value);
  } catch {
    throw new UsageError(`--${name}: not an amount in so'm (e.g. 50000 or -1250.50)`);
  }
}

export function money(tiyin: bigint | null): string {
  return tiyin === null ? '-' : `${tiyinToSom(tiyin)} UZS`;
}

const magnitude = (tiyin: bigint): bigint => (tiyin < 0n ? -tiyin : tiyin);

/** What a service needs to accept an amount above the threshold, and the clean-up after it. */
export interface Confirmation {
  readonly fields: { readonly confirmAmountTiyin?: bigint; readonly otp?: OtpAnswer };
  /** Removes the code's message and challenge, whatever happened (call it in `finally`). */
  done(): Promise<void>;
}

const NOTHING: Confirmation = { fields: {}, done: () => Promise.resolve() };

/**
 * Above ADMIN_CONFIRM_THRESHOLD_TIYIN (docs/05 §7, D-46) the operator re-types the amount, and
 * when it matches, the owner gets a one-time code from the bot, bound to the action, the amount
 * and the target, and types it here (not echoed). The service checks both. A wrong re-typed
 * amount sends no code: the service refuses it as it is. At or below the threshold nothing is
 * asked.
 */
export async function confirmIfLarge(
  ctx: CliContext,
  scope: { action: OwnerOtpAction; amountTiyin: bigint; target: string; flags?: string },
  signed = false,
): Promise<Confirmation> {
  const threshold = ctx.app.get<AppConfig>(APP_CONFIG).ADMIN_CONFIRM_THRESHOLD_TIYIN;
  if (magnitude(scope.amountTiyin) <= threshold) return NOTHING;
  const answer = await ctx.io.prompt(
    `${money(scope.amountTiyin)} is above the confirmation threshold (${money(threshold)}). ` +
      `Re-type the amount in so'm to confirm: `,
  );
  let confirmAmountTiyin: bigint;
  try {
    confirmAmountTiyin = signed
      ? parseSignedMajor('UZS', answer.trim())
      : somToTiyin(answer.trim());
  } catch {
    throw new UsageError('the re-typed amount is not an amount');
  }
  if (confirmAmountTiyin !== scope.amountTiyin)
    return { ...NOTHING, fields: { confirmAmountTiyin } };
  const issuer = ctx.app.get(OwnerOtpIssuer);
  const challenge = await issuer.issue({ ...scope, amountTiyin: confirmAmountTiyin });
  const done = () => issuer.discard(challenge.challengeId);
  try {
    ctx.io.out(
      `A one-time code was sent to the owner's Telegram (valid ${String(challenge.expiresInSec / 60)} min).`,
    );
    const code = (await ctx.io.secret('Code from the bot (not shown): ')).trim();
    return {
      fields: { confirmAmountTiyin, otp: { challengeId: challenge.challengeId, code } },
      done,
    };
  } catch (error) {
    await done();
    throw error;
  }
}

/** One `key=value` line per field: easy to read and to grep. */
export function report(ctx: CliContext, fields: Record<string, string | number | boolean | null>) {
  for (const [key, value] of Object.entries(fields)) {
    // Values may come from the database (a note, a channel): never raw control characters,
    // never a second line (n1).
    ctx.io.out(`${key}=${value === null ? '-' : terminalSafe(String(value))}`);
  }
}

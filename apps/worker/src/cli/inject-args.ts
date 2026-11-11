import { parseArgs } from 'node:util';
import { somToTiyin, type BankDirection, type BankFeedSource } from '@repo/shared';

export interface InjectArgs {
  readonly source: BankFeedSource;
  readonly direction: BankDirection;
  readonly amountTiyin: bigint;
  readonly last4: string;
  /** The balance after this operation; default: the card's last balance +/- the amount. */
  readonly balanceTiyin: bigint | null;
}

export const INJECT_USAGE =
  'usage: bank-feed-inject --source humo|uzcard --amount <so‘m, e.g. 50017 or 50017.00> ' +
  '--last4 <4 digits> [--debit] [--balance <so‘m after the operation>]';

export class InjectUsageError extends Error {
  constructor(reason: string) {
    super(`${reason}\n${INJECT_USAGE}`);
    this.name = 'InjectUsageError';
  }
}

const SOURCES: Readonly<Record<string, BankFeedSource>> = {
  humo: 'HUMO_BOT',
  uzcard: 'UZCARD_BOT',
};

function som(value: string | undefined, name: string): bigint | null {
  if (value === undefined) return null;
  try {
    const tiyin = somToTiyin(value);
    if (tiyin <= 0n) throw new InjectUsageError(`--${name} must be positive`);
    return tiyin;
  } catch (error) {
    if (error instanceof InjectUsageError) throw error;
    throw new InjectUsageError(`--${name} must be an amount in so‘m`);
  }
}

/** The inject tool's arguments (BANK_FEED_MODE=fake only; checked by the caller). */
export function parseInjectArgs(argv: readonly string[]): InjectArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        source: { type: 'string' },
        amount: { type: 'string' },
        last4: { type: 'string' },
        balance: { type: 'string' },
        debit: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new InjectUsageError('unknown or malformed option');
  }
  const source = values.source === undefined ? undefined : SOURCES[values.source];
  if (source === undefined) throw new InjectUsageError('--source must be humo or uzcard');
  const amountTiyin = som(values.amount, 'amount');
  if (amountTiyin === null) throw new InjectUsageError('--amount is required');
  const last4 = values.last4 ?? '';
  if (!/^\d{4}$/.test(last4)) throw new InjectUsageError('--last4 must be 4 digits');
  return {
    source,
    direction: values.debit === true ? 'DEBIT' : 'CREDIT',
    amountTiyin,
    last4,
    balanceTiyin: som(values.balance, 'balance'),
  };
}

/** The balance after the operation: given, or the last one moved by the amount. */
export function balanceAfter(args: InjectArgs, previous: bigint | null): bigint {
  if (args.balanceTiyin !== null) return args.balanceTiyin;
  const base = previous ?? (args.direction === 'DEBIT' ? args.amountTiyin : 0n);
  const next = args.direction === 'CREDIT' ? base + args.amountTiyin : base - args.amountTiyin;
  if (next < 0n) throw new InjectUsageError('the balance would go below zero; pass --balance');
  return next;
}

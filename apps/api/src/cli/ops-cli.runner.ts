import type { INestApplicationContext } from '@nestjs/common';
import { scrubSecretsInText } from '@repo/shared';
import { AppError } from '../common/exceptions/app-error';
import type { CliIo } from './cli-io';
import type { CliSession } from './cli-session';
import { CARD_COMMANDS } from './commands/card.commands';
import { UsageError, type CliCommand } from './commands/command';
import { REVIEW_COMMANDS } from './commands/review.commands';
import { WALLET_COMMANDS } from './commands/wallet.commands';

export const OPS_COMMANDS: readonly CliCommand[] = [
  ...REVIEW_COMMANDS,
  ...CARD_COMMANDS,
  ...WALLET_COMMANDS,
];

/** 0 done, 1 refused or failed (nothing half-written: every command is one transaction), 2 usage. */
export type ExitCode = 0 | 1 | 2;

const HELP_HEADER = [
  'ggpin owner CLI (internal). Runs on the server with the API environment; no HTTP.',
  'Every changing command needs --reason and --operator and writes one AuditLog row',
  "(actorType CLI) in the same transaction as the change. Money is given in so'm.",
  '',
  'usage: node --env-file-if-exists=.env dist/cli/ops-cli.js <command> [arguments]',
  '       (or npm --logs-max=0 run -s ops -- <command> ...)   help <command> for details',
  'Above the confirmation threshold the amount is re-typed and the owner types a one-time',
  "code the bot sends to the owner's Telegram (D-46).",
  '',
];

export function helpText(): string[] {
  const width = Math.max(...OPS_COMMANDS.map((c) => c.name.length));
  return [...HELP_HEADER, ...OPS_COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`)];
}

/** Names the command before the app boots, so `help` and typos need no database. */
export function findCommand(name: string | undefined): CliCommand | undefined {
  return OPS_COMMANDS.find((c) => c.name === name);
}

/**
 * Runs one command. A refusal of a service (AppError) prints its code and details: the field
 * and the reason, never the value (a PAN, an amount). Any other error prints its name and a
 * scrubbed message; nothing is retried here.
 */
export async function runCommand(
  command: CliCommand,
  argv: readonly string[],
  app: INestApplicationContext,
  io: CliIo,
  session: CliSession,
): Promise<ExitCode> {
  try {
    await command.run({ app, io, session }, argv);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`usage error: ${error.message}`);
      io.err(`usage: ${command.usage}`);
      return 2;
    }
    if (error instanceof AppError) {
      io.err(
        `refused: ${error.code}${error.details === undefined ? '' : ` ${detailsText(error.details)}`}`,
      );
      return 1;
    }
    const name = error instanceof Error ? error.name : 'unknown';
    const message = error instanceof Error ? scrubSecretsInText(error.message) : '';
    io.err(`failed: ${name} ${message}`.trim());
    return 1;
  }
}

function detailsText(details: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(details, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

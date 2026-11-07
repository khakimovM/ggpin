import type { INestApplicationContext } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { CliSession } from '../cli-session';
import { findCommand, runCommand } from '../ops-cli.runner';
import { scriptedIo, type Answer } from './scripted-io';

// The CLI without a database: only what the commands under test ask the context for.

export const THRESHOLD = 100_000_000n; // 1 000 000 so'm
export const WHO = ['--reason', 'why', '--operator', 'aziz'];
export const NO_SESSION: CliSession = { sshIp: null, osUser: null };

export function fakeApp(services: Map<unknown, unknown>): INestApplicationContext {
  const all = new Map<unknown, unknown>([
    [APP_CONFIG, { ADMIN_CONFIRM_THRESHOLD_TIYIN: THRESHOLD }],
    ...services,
  ]);
  return {
    get: (token: unknown) => {
      if (!all.has(token)) throw new Error('not faked');
      return all.get(token);
    },
  } as unknown as INestApplicationContext;
}

export async function runFake(
  argv: readonly string[],
  services = new Map<unknown, unknown>(),
  answers: Answer[] = [],
  session: CliSession = NO_SESSION,
) {
  const [name, ...rest] = argv;
  const command = findCommand(name);
  if (command === undefined) throw new Error('no such command');
  const terminal = scriptedIo(answers);
  const code = await runCommand(command, rest, fakeApp(services), terminal.io, session);
  return { code, ...terminal };
}

/** A WalletChange-shaped answer of WalletAdminService. */
export const NOOP_CHANGE = {
  applied: false,
  userId: 'u1',
  auditId: 'a1',
  ledgerEntryId: 'e1',
  balanceTiyin: 0n,
  frozen: false,
  newlyFrozen: false,
  alertQueued: false,
};

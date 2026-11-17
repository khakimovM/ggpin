import { scriptedIo } from '../../../cli/__tests__/scripted-io';
import { findCommand, runCommand } from '../../../cli/ops-cli.runner';
import type { AdminE2e } from './admin-e2e.api';

export interface CliRun {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

/** The owner CLI against the harness's app: what an SSH session would see, and its exit code. */
export function cliOf(t: AdminE2e): (argv: readonly string[]) => Promise<CliRun> {
  const session = { sshIp: null, osUser: 'e2e-os-user' };
  return async (argv) => {
    const [name = '', ...rest] = argv;
    const command = findCommand(name);
    if (command === undefined) throw new Error(`no command ${name}`);
    const io = scriptedIo();
    const code = await runCommand(command, rest, t.app(), io.io, session);
    return { code, out: io.out, err: io.err };
  };
}

/** --reason, --operator and --ip of every changing command in the e2e suites. */
export const CLI_ACTOR = [
  '--reason',
  'bootstrap of the e2e admin',
  '--operator',
  'e2e-owner',
  '--ip',
  '203.0.113.9',
] as const;

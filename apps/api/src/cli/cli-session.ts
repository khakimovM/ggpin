import { isIP } from 'node:net';
import { userInfo } from 'node:os';

/** Who runs this CLI process, for the AuditLog (S8-L5). */
export interface CliSession {
  /** The SSH client address (SSH_CONNECTION, else SSH_CLIENT), null on a local console. */
  readonly sshIp: string | null;
  /** The OS login, with the sudo caller when run through sudo; null when it cannot be read. */
  readonly osUser: string | null;
}

type Environment = Readonly<Partial<Record<'SSH_CONNECTION' | 'SSH_CLIENT' | 'SUDO_USER', string>>>;

// Both start with the client address: "client port server port" / "client port port".
function sshClient(env: Environment): string | null {
  for (const name of ['SSH_CONNECTION', 'SSH_CLIENT'] as const) {
    const first = env[name]?.trim().split(/\s+/)[0];
    if (first !== undefined && isIP(first) !== 0) return first;
  }
  return null;
}

function login(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null; // no passwd entry for the uid (some containers)
  }
}

/**
 * Read from the process once, in the entry point, so no command reads the environment itself
 * (the API's config is validated in env.ts; these are facts about the terminal, not config).
 */
export function sessionOf(env: Environment, osLogin: string | null = login()): CliSession {
  const sudo = env['SUDO_USER']?.trim();
  const osUser =
    osLogin === null
      ? null
      : sudo === undefined || sudo === ''
        ? osLogin
        : `${osLogin} (sudo from ${sudo})`;
  return { sshIp: sshClient(env), osUser };
}

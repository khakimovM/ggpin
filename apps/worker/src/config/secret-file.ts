import { closeSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs';

/** Why a secret file was refused. The message names the variable, never the path or the value. */
export class SecretFileError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SecretFileError';
  }
}

export type SecretFileReader = (path: string) => string;

/** Group/other bits and the owner's execute bit: only 0400 and 0600 (or narrower) pass. */
const TOO_OPEN = 0o177;

/** True when a file of this mode may be read by others (POSIX only; Windows has no such bits). */
export function tooOpen(mode: number, platform: string): boolean {
  return platform !== 'win32' && (mode & TOO_OPEN) !== 0;
}

/**
 * Reads a Docker-secret style file once (D-52 D3). On POSIX the file must be private to its
 * owner (0400/0600): a key readable by others is refused, not used. The mode is checked on the
 * OPENED descriptor (fstat) and the content read from that same descriptor, so the file cannot be
 * swapped between the check and the read (D-52 r2, review I-1). Windows has no such mode bits:
 * allowed for dev only, a production process on win32 is refused. The content is trimmed; an
 * empty file is refused. Compose `file:` secrets keep the host file's mode and owner (runbook:
 * `install -m 0400 -o <worker uid>`), so a key the worker cannot open says "owner differs".
 */
export function readSecretFile(
  path: string,
  platform: string = process.platform,
  production = false,
): string {
  if (production && platform === 'win32') {
    throw new SecretFileError('a production worker on Windows cannot check the file mode');
  }
  let text: string;
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new SecretFileError('is not a regular file');
    if (tooOpen(stat.mode, platform)) {
      throw new SecretFileError('file permissions are wider than 0600 (chmod 0400 or 0600)');
    }
    text = readFileSync(fd, 'utf8').trim();
  } catch (error) {
    if (error instanceof SecretFileError) throw error;
    throw new SecretFileError(openFailure(error, path));
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (text === '') throw new SecretFileError('the file is empty');
  return text;
}

/** Why open/read failed, without the path: a directory, or a file of another owner. */
function openFailure(error: unknown, path: string): string {
  const code = error instanceof Error && 'code' in error ? error.code : null;
  if (code === 'EISDIR') return 'is not a regular file';
  if (code === 'EACCES' && process.getuid !== undefined) {
    try {
      const owner = statSync(path).uid;
      const self = process.getuid();
      if (owner !== self) {
        return `cannot be read: the file owner differs (uid ${String(owner)}, the worker runs as uid ${String(self)})`;
      }
    } catch {
      // Not even stat-able: the plain reason below.
    }
  }
  return 'cannot be read';
}

export interface BankFeedKeySource {
  /** The key text (from the file, or inline outside production), or undefined. */
  readonly key: string | undefined;
  readonly problems: readonly string[];
}

type Source = Readonly<Record<string, string | undefined>>;

/**
 * Where BANK_FEED_ENC_KEY comes from (D-52 D3): BANK_FEED_ENC_KEY_FILE (a Docker secret; the
 * only way in production) or the inline BANK_FEED_ENC_KEY (dev/test only). Both at once is
 * refused. The worker and the login CLI both use this.
 */
export function bankFeedKeySource(
  source: Source,
  production: boolean,
  read: SecretFileReader = (path) => readSecretFile(path, process.platform, production),
): BankFeedKeySource {
  const inline = source.BANK_FEED_ENC_KEY;
  const file = source.BANK_FEED_ENC_KEY_FILE;
  const problems: string[] = [];
  if (inline !== undefined && file !== undefined) {
    problems.push('BANK_FEED_ENC_KEY and BANK_FEED_ENC_KEY_FILE: set only one of them');
  }
  if (production && inline !== undefined) {
    problems.push(
      'BANK_FEED_ENC_KEY: an inline key is refused in production; use BANK_FEED_ENC_KEY_FILE (a Docker secret)',
    );
  }
  if (problems.length > 0) return { key: undefined, problems };
  if (file === undefined) return { key: inline, problems };
  try {
    return { key: read(file), problems };
  } catch (error) {
    const reason = error instanceof SecretFileError ? error.message : 'cannot be read';
    return { key: undefined, problems: [`BANK_FEED_ENC_KEY_FILE: ${reason}`] };
  }
}

/**
 * After the boot read (D-52 D3): the key and its file path leave the process environment, so a
 * child process, a crash dump of `process.env` or a later library cannot see them.
 */
export function forgetBankFeedKey(env: NodeJS.ProcessEnv): void {
  delete env.BANK_FEED_ENC_KEY;
  delete env.BANK_FEED_ENC_KEY_FILE;
}

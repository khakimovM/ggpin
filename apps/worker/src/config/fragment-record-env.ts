type Source = Readonly<Record<string, string | undefined>>;

/**
 * The Fragment recording tool (plan S0b) runs only on the owner's machine, never in production:
 * it reads a browser session and writes raw responses to disk. It is started without a .env file
 * (S-8) and refuses an environment that could weaken, redirect or trace it (S-8, R-11, N8):
 * NODE_ENV=production, TLS checks off, NODE_OPTIONS, extra or system CA certificates (F-8), debug
 * output, or a proxy. Limit: NODE_OPTIONS is read after Node has already applied it (a `--require` preload
 * has run by then); the refusal stops the recording, it cannot undo the preload. Lives in config/
 * because it reads the process environment. Null: allowed. Reasons name variables, never values.
 */
export function fragmentRecordEnvRefusal(source: Source = process.env): string | null {
  const nodeEnv = (source['NODE_ENV'] ?? '').trim().toLowerCase();
  if (nodeEnv === 'production') return 'NODE_ENV is production';
  if ((source['NODE_TLS_REJECT_UNAUTHORIZED'] ?? '').trim() === '0') {
    return 'NODE_TLS_REJECT_UNAUTHORIZED=0 turns TLS checks off';
  }
  if ((source['NODE_OPTIONS'] ?? '').trim() !== '') return 'NODE_OPTIONS is set';
  for (const name of REFUSED_WHEN_SET) {
    for (const key of [name, name.toLowerCase()]) {
      if ((source[key] ?? '').trim() !== '') return `${key} is set`;
    }
  }
  return null;
}

const REFUSED_WHEN_SET = [
  'NODE_EXTRA_CA_CERTS',
  'NODE_DEBUG',
  'NODE_USE_ENV_PROXY',
  'NODE_USE_SYSTEM_CA',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
] as const;

/** OneDrive roots (Windows sets these); the recorder refuses folders inside them (R-5). */
export function fragmentRecordOneDriveRoots(source: Source = process.env): string[] {
  return [source['OneDrive'], source['OneDriveConsumer'], source['OneDriveCommercial']].filter(
    (v): v is string => v !== undefined && v.trim() !== '',
  );
}

/**
 * True when npm started the tool (F-1): npm prints the command line (username, id, wallet, name)
 * to the console and may keep it in its log, so the tool warns. Only the variable's presence counts.
 */
export function fragmentRecordViaNpm(source: Source = process.env): boolean {
  return (source['npm_lifecycle_event'] ?? '') !== '';
}

/**
 * Node options given on the command line (I-4: `--require`, `--inspect`, `--use-system-ca`, …) can
 * load code or open a debugger before the tool runs, like NODE_OPTIONS: refused. Names no value.
 */
export function fragmentRecordExecArgvRefusal(
  execArgv: readonly string[] = process.execArgv,
): string | null {
  return execArgv.length > 0 ? 'node command-line options are set' : null;
}

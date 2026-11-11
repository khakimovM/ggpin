import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

// Starting and stopping the real processes of the journeys (API, worker, inject tool). Each runs
// from its built `dist` with a short environment given here, never the developer's shell, and with
// the loopback guard preloaded (loopback-only.cjs), so no connection can leave the machine. The
// guard is put in NODE_OPTIONS, which worker threads and child processes inherit.

export const GUARD_PATH = path.resolve(__dirname, 'loopback-only.cjs');
const guardOption = () => `--require "${GUARD_PATH.split(path.sep).join('/')}"`;
const KEEP_OUTPUT = 200_000;
const KILL_AFTER_MS = 10_000;

export interface Service {
  readonly name: string;
  /** The tail of what the process wrote to stdout and stderr, for a failure message. */
  output: () => string;
  exited: () => boolean;
  /** The exit code once the process has ended, otherwise undefined. */
  exitCode: () => number | null | undefined;
  /** Every `LOOPBACK_GUARD blocked ...` line, collected as it streamed in (the tail cut never loses one). */
  guardHits: () => string[];
  /** Whether the guard announced itself (`LOOPBACK_GUARD active`): without it the run was not guarded. */
  guardActive: () => boolean;
  stop: () => Promise<void>;
}

export function spawnService(
  name: string,
  entry: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[] = [],
): Service {
  const child: ChildProcess = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: { ...env, NODE_OPTIONS: guardOption() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const hits: string[] = [];
  let active = false;
  // Lines are cut here, per stream, so a line split across two chunks is still one line.
  const pending = { out: '', err: '' };
  const onLine = (line: string) => {
    if (line.includes('LOOPBACK_GUARD blocked') || line.includes('LOOPBACK_GUARD:'))
      hits.push(line);
    if (line.includes('LOOPBACK_GUARD active')) active = true;
  };
  const collect = (stream: 'out' | 'err') => (chunk: Buffer) => {
    const text = chunk.toString();
    output = (output + text).slice(-KEEP_OUTPUT);
    const lines = (pending[stream] + text).split('\n');
    pending[stream] = lines.pop() ?? '';
    lines.forEach(onLine);
  };
  child.stdout?.on('data', collect('out'));
  child.stderr?.on('data', collect('err'));
  let exited = false;
  let code: number | null | undefined;
  child.on('exit', (exitCode) => {
    exited = true;
    code = exitCode;
    // A last line without a newline.
    onLine(pending.out);
    onLine(pending.err);
  });
  return {
    name,
    output: () => output,
    exited: () => exited,
    exitCode: () => code,
    guardHits: () => [...hits],
    guardActive: () => active,
    stop: async () => {
      if (exited) return;
      await new Promise<void>((resolve) => {
        // A process that ignores the first signal is killed outright: a hung stop must not hang
        // the whole run (and the lock with it).
        const timer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      });
    },
  };
}

export interface RunResult {
  code: number | null;
  output: string;
  guardHits: string[];
  guardActive: boolean;
}

/** Runs a short-lived process to its end. */
export function runToEnd(
  name: string,
  entry: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  timeoutMs = 60_000,
): Promise<RunResult> {
  const service = spawnService(name, entry, cwd, env, args);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      void service.stop();
      reject(new Error(`${name} did not finish within ${String(timeoutMs)} ms.`));
    }, timeoutMs);
    const poll: NodeJS.Timeout = setInterval(() => {
      if (!service.exited()) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve({
        code: service.exitCode() ?? null,
        output: service.output(),
        guardHits: service.guardHits(),
        guardActive: service.guardActive(),
      });
    }, 100);
  });
}

/** Guard hits of all the given services, in one list. */
export function guardHits(...services: readonly Service[]): string[] {
  return services.flatMap((service) => service.guardHits());
}

// Runs `npm audit --json --omit=dev` and returns its stdout, or an error string when the run
// itself cannot be trusted. The spawn function is a parameter so the checks are testable.
import { spawnSync } from 'node:child_process';

export const AUDIT_TIMEOUT_MS = 300_000;

/**
 * @param {string} cwd  repository root
 * @param {typeof spawnSync} [spawn]
 * @returns {{ stdout: string, stderr: string, error: string | null }}
 */
export function runNpmAudit(cwd, spawn = spawnSync) {
  const res = spawn('npm', ['audit', '--json', '--omit=dev'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: AUDIT_TIMEOUT_MS,
    shell: process.platform === 'win32',
  });
  const stdout = typeof res.stdout === 'string' ? res.stdout : '';
  const stderr = typeof res.stderr === 'string' ? res.stderr.trim() : '';
  let error = null;
  if (res.error) error = `could not run npm audit (${res.error.message})`;
  else if (res.signal)
    error = `npm audit was killed by ${res.signal} (timeout ${AUDIT_TIMEOUT_MS} ms?)`;
  // 0: nothing found, 1: something found. Anything else is npm failing, not a verdict.
  else if (res.status !== 0 && res.status !== 1) error = `npm audit exited ${res.status}`;
  return { stdout, stderr, error };
}

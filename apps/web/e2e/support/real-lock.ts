import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The real stack (API on port 5000, the worker, one database and Redis DB 13) exists once per
// machine, but Playwright may run spec FILES in parallel workers (the `real-api` project runs with
// one worker; this stays correct if someone starts two Playwright runs). Every file that starts
// the stack takes this lock first. A directory is the lock (mkdir is atomic); it holds the owner's
// pid, to take over a lock left by a crashed run, and a random token, so that only its owner can
// ever remove it.

const LOCK_DIR = path.join(os.tmpdir(), 'ggpin-web-e2e-real-stack.lock');
const WAIT_LIMIT_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isExists = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'EEXIST';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but is not ours.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function readField(dir: string, name: string): string | null {
  try {
    return readFileSync(path.join(dir, name), 'utf8');
  } catch {
    return null;
  }
}

function pidIn(dir: string): number | null {
  const pid = Number(readField(dir, 'pid'));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Takes over the lock of a holder that is dead. Of several waiters that see the same dead holder
 * only one wins the rename; and what it renamed is checked to be the DEAD holder's lock: if a
 * live process took the lock in between, the directory is put back.
 */
function takeOverDead(pid: number): void {
  const dead = `${LOCK_DIR}.dead-${String(pid)}-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(LOCK_DIR, dead);
  } catch {
    return; // another waiter took it over first
  }
  const moved = pidIn(dead);
  if (moved === pid || moved === null) {
    rmSync(dead, { recursive: true, force: true });
    return;
  }
  // A live holder's lock was moved by mistake: give it back (if it is free again).
  try {
    renameSync(dead, LOCK_DIR);
  } catch {
    rmSync(dead, { recursive: true, force: true });
  }
}

/** Waits for the lock, returns the function that frees it (safe to call twice). */
export async function acquireRealStackLock(): Promise<() => void> {
  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(path.join(LOCK_DIR, 'pid'), String(process.pid));
      writeFileSync(path.join(LOCK_DIR, 'token'), token);
      break;
    } catch (error) {
      if (!isExists(error)) throw error;
    }
    const pid = pidIn(LOCK_DIR);
    // No pid yet: the holder is between mkdir and writeFile; wait and look again.
    if (pid !== null && pid !== process.pid && !alive(pid)) {
      takeOverDead(pid);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error('Another run of the real-API journeys holds the stack for over 15 minutes.');
    }
    await sleep(500);
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // Only the owner removes it: after a takeover the directory is somebody else's.
    if (readField(LOCK_DIR, 'token') === token) rmSync(LOCK_DIR, { recursive: true, force: true });
  };
  process.once('exit', release);
  return release;
}

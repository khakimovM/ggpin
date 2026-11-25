import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

// Where the recorder may read and write (fix rounds S-7, R-3, R-5, R-10). Every check runs on the
// REAL path (junctions and symlinks resolved through the nearest existing parent), so a junction
// cannot lead a folder into a git repository. UNC/device paths and OneDrive folders are refused.

export class OutputRefusal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'OutputRefusal';
  }
}

const BS = String.fromCharCode(92);
const caseless = process.platform === 'win32';
const norm = (p: string): string => (caseless ? p.toLowerCase() : p);

/** The real path of `p`: its nearest existing ancestor resolved, the missing rest appended. */
export function realPathOf(p: string): string {
  let current = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  const real = existsSync(current) ? realpathSync.native(current) : current;
  return path.join(real, ...rest);
}

/** The nearest ancestor (or the folder itself) of the REAL path that holds `.git`, or null. */
export function gitRootOf(dir: string): string | null {
  let current = realPathOf(dir);
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** True when `child` is `parent` or inside it, compared by real paths. */
export function inside(child: string, parent: string): boolean {
  const rel = path.relative(norm(realPathOf(parent)), norm(realPathOf(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const isUnc = (p: string): boolean => p.startsWith(`${BS}${BS}`) || p.startsWith('//');

/** Segments of the real path, for name checks (OneDrive, ggpin-secrets). */
const segments = (p: string): string[] => norm(realPathOf(p)).split(/[\\/]+/);

export interface PathPolicy {
  /** OneDrive roots from the environment (config/fragment-record-env.ts). */
  readonly oneDriveRoots: readonly string[];
}

/** Refuses UNC/device paths, OneDrive folders and anything inside a git repository. */
export function assertLocalPath(p: string, option: string, policy: PathPolicy): void {
  // Windows drops a trailing dot or space from a name, so `repo.` would not be the folder the
  // checks below looked at (audit P7): such names are refused outright.
  const odd = path
    .resolve(p)
    .split(/[\\/]+/)
    .some((s) => s !== '.' && s !== '..' && /[. ]$/.test(s));
  if (odd) throw new OutputRefusal(`${option} has a name ending in a dot or a space`);
  if (isUnc(p) || isUnc(path.resolve(p)) || isUnc(realPathOf(p))) {
    throw new OutputRefusal(`${option} is a network or device path; use a local folder`);
  }
  const onOneDrive =
    segments(p).some((s) => s.startsWith('onedrive')) ||
    policy.oneDriveRoots.some((root) => root.trim() !== '' && inside(p, root));
  if (onOneDrive) throw new OutputRefusal(`${option} is inside OneDrive; use a local folder`);
  if (gitRootOf(p) !== null) {
    throw new OutputRefusal(`${option} is inside a git repository; the tool never uses one`);
  }
}

/** The staging folder is read by the lead session, which must never read ggpin-secrets (R-3). */
export function assertNotInSecrets(p: string, option: string): void {
  if (segments(p).includes('ggpin-secrets')) {
    throw new OutputRefusal(`${option} is inside ggpin-secrets; staging must live outside it`);
  }
}

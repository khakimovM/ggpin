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
  // No ancestor at all exists (not even the drive root, e.g. a disconnected mapped drive): there
  // is nothing real to check against, so refuse (fail closed). The message names no value.
  if (!existsSync(current)) {
    throw new OutputRefusal('a path has no existing folder above it; use a local folder');
  }
  return path.join(realpathSync.native(current), ...rest);
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

// Windows reads both slashes as separators, so ANY two leading ones (two backslashes, two
// slashes, or one of each) open a UNC or device path (server share, `?` or `.` device prefix).
const isUnc = (p: string): boolean => /^[\\/]{2}/.test(p);

/**
 * Refuses a UNC/device form by its text alone. The args parser runs it on the value AS GIVEN
 * (on Linux/macOS `path.resolve` turns a backslash device path into a relative name under the cwd
 * and `//host/share` into `/host/share`, erasing the form), on the resolved value and on the
 * default folders (a UNC cwd or home). Such values are refused with no file-system call, hence no
 * SMB request. A LOCAL symlink or junction that points to a share is different: it shows only
 * once `realPathOf` has resolved it, i.e. after file-system calls on the local link.
 * Platform-independent on purpose (fail closed): the tool runs on Windows, but a check run on
 * another OS must not quietly accept what Windows would treat as a network path.
 */
export function assertLocalForm(raw: string, option: string): void {
  if (isUnc(raw)) {
    throw new OutputRefusal(`${option} is a network or device path; use a local folder`);
  }
}

/**
 * Segments of the real path, for name checks (OneDrive, ggpin-secrets). Lower-cased on EVERY OS:
 * a case-sensitive file system must not let `OneDrive - Org` or `GGPIN-Secrets` slip past a name
 * check (fail closed). `inside()` keeps `norm`, since it compares real paths, not names.
 * An NTFS stream suffix (`name::$INDEX_ALLOCATION`, `name:stream`) is cut off, so a name check
 * sees the folder the suffix really names even where `assertLocalPath` has not run first.
 */
const segments = (p: string): string[] =>
  realPathOf(p)
    .toLowerCase()
    .split(/[\\/]+/)
    .map((s) => s.split(':')[0] ?? s);

export interface PathPolicy {
  /** OneDrive roots from the environment (config/fragment-record-env.ts). */
  readonly oneDriveRoots: readonly string[];
}

/** Refuses UNC/device paths, OneDrive folders and anything inside a git repository. */
export function assertLocalPath(p: string, option: string, policy: PathPolicy): void {
  // Text checks first: nothing below may touch the file system for a network path.
  assertLocalForm(p, option);
  // An NTFS stream suffix (`name::$INDEX_ALLOCATION`) names the folder `name` itself, so the name
  // checks would compare the wrong text and mkdir would create `name` (a probe showed
  // `ggpin-secrets::$INDEX_ALLOCATION` making `ggpin-secrets`). A `:` anywhere but in a drive
  // letter is refused before any folder is made.
  if (
    path
      .resolve(p)
      .replace(/^[A-Za-z]:/, '')
      .includes(':')
  ) {
    throw new OutputRefusal(`${option} has a ':' in a folder name; use a plain local folder`);
  }
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

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { OneDriveRoot } from '../config/fragment-record-env';

// Where the recorder may read and write (fix rounds S-7, R-3, R-5, R-10). Every check runs on the
// REAL path (junctions and symlinks resolved through the nearest existing parent), so a junction
// cannot lead a folder into a git repository. UNC/device paths and OneDrive folders are refused.

export class OutputRefusal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'OutputRefusal';
  }
}

/** Path rules: Windows (drive letters, either slash, any letter case) or POSIX. */
export type PathFlavour = 'win32' | 'posix';
const HOST: PathFlavour = process.platform === 'win32' ? 'win32' : 'posix';
const LOCAL = 'use a local folder';

/**
 * The real path of `p`: its nearest existing ancestor resolved, the missing rest appended.
 * `what` names the value in a refusal (an option or a variable, never the value itself) and
 * `advice` says what to do about it.
 */
export function realPathOf(p: string, what = 'a path', advice = LOCAL): string {
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
    throw new OutputRefusal(`${what} has no existing folder above it; ${advice}`);
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

/**
 * True when real path `child` is real path `parent` or inside it. Decided by segments (audit L-7):
 * only a first segment of exactly `..` leaves the parent, so a folder named `..x` is inside it.
 * Windows compares in any letter case; another drive gives an absolute result, i.e. outside.
 */
export function within(child: string, parent: string, flavour: PathFlavour = HOST): boolean {
  const api = path[flavour];
  const fold = (p: string): string => (flavour === 'win32' ? p.toLowerCase() : p);
  const rel = api.relative(fold(parent), fold(child));
  return rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}

/**
 * A OneDrive root must be absolute (audit I-1): a relative or drive-relative root (`OneDrive`,
 * `C:OneDrive`, a leading backslash) would be resolved under the cwd and compared with the wrong
 * folder. Windows: a drive letter, a colon and a slash. Elsewhere (the Linux CI): a leading `/`.
 */
export function isAbsoluteRoot(p: string, flavour: PathFlavour = HOST): boolean {
  return flavour === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/');
}

/** True when `child` is `parent` or inside it, compared by real paths. */
export function inside(child: string, parent: string): boolean {
  return within(realPathOf(child), realPathOf(parent));
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
 * check (fail closed). `within()` folds case only on Windows, since it compares real paths, not names.
 * An NTFS stream suffix (`name::$INDEX_ALLOCATION`, `name:stream`) is cut off, so a name check
 * sees the folder the suffix really names even where `assertLocalPath` has not run first.
 */
const segments = (real: string): string[] =>
  real
    .toLowerCase()
    .split(/[\\/]+/)
    .map((s) => s.split(':')[0] ?? s);

export interface PathPolicy {
  /** OneDrive roots from the environment (config/fragment-record-env.ts). */
  readonly oneDriveRoots: readonly OneDriveRoot[];
}

/**
 * What a refusal names (`label`) and, for a OneDrive root, the advice that replaces the option's
 * (`rootFix`: fix or unset the variable). Options keep their messages unchanged.
 */
interface Subject {
  readonly label: string;
  readonly rootFix: string | null;
}

function refuse(s: Subject, problem: string, optionAdvice: string | null): never {
  const advice = s.rootFix ?? optionAdvice;
  throw new OutputRefusal(
    advice === null ? `${s.label} ${problem}` : `${s.label} ${problem}; ${advice}`,
  );
}

/**
 * The text checks every path passes before anything resolves it, so none of them touches the file
 * system: a path option as given and a OneDrive root from the environment (which must also be
 * absolute, I-1).
 */
function assertPlainForm(p: string, s: Subject): void {
  if (isUnc(p)) refuse(s, 'is a network or device path', LOCAL);
  if (s.rootFix !== null && !isAbsoluteRoot(p)) refuse(s, 'is not an absolute path', null);
  const resolved = path.resolve(p);
  // An NTFS stream suffix (`name::$INDEX_ALLOCATION`) names the folder `name` itself, so the name
  // checks would compare the wrong text and mkdir would create `name` (a probe showed
  // `ggpin-secrets::$INDEX_ALLOCATION` making `ggpin-secrets`). A `:` anywhere but in a drive
  // letter is refused before any folder is made.
  if (resolved.replace(/^[A-Za-z]:/, '').includes(':')) {
    refuse(s, "has a ':' in a folder name", 'use a plain local folder');
  }
  // Windows drops a trailing dot or space from a name, so `repo.` would not be the folder the
  // checks below looked at (audit P7): such names are refused outright.
  const odd = resolved.split(/[\\/]+/).some((x) => x !== '.' && x !== '..' && /[. ]$/.test(x));
  if (odd) refuse(s, 'has a name ending in a dot or a space', null);
  if (isUnc(resolved)) refuse(s, 'is a network or device path', LOCAL);
}

/**
 * True when real path `real` is inside a OneDrive root. A root passes the same text checks as an
 * option before it is resolved (audit L-5: a network root must not cause an SMB request, a `:` or
 * relative root must not compare the wrong folder). A root that fails them, or has no existing
 * folder above it (L-6, a disconnected mapped drive), is refused, naming its variable: fail closed,
 * as for the options, since skipping it would let the recorder write into the very folder the
 * variable names. Accepted risk (as L-3): a LOCAL symlink or junction root that points to a share
 * still causes one SMB request when `realPathOf` resolves it.
 */
function insideOneDriveRoot(real: string, roots: readonly OneDriveRoot[]): boolean {
  return roots.some((root) => {
    if (root.path.trim() === '') return false;
    const fix = `fix or unset ${root.name}`;
    const s: Subject = {
      label: `environment variable ${root.name} (a OneDrive root)`,
      rootFix: fix,
    };
    assertPlainForm(root.path, s);
    return within(real, realPathOf(root.path, s.label, fix));
  });
}

/** Refuses UNC/device paths, OneDrive folders and anything inside a git repository. */
export function assertLocalPath(p: string, option: string, policy: PathPolicy): void {
  // Text checks first: nothing below may touch the file system for a network path.
  assertPlainForm(p, { label: option, rootFix: null });
  const real = realPathOf(p, option);
  // A local link that leads to a share shows only on the real path.
  if (isUnc(real)) {
    throw new OutputRefusal(`${option} is a network or device path; use a local folder`);
  }
  const onOneDrive =
    segments(real).some((s) => s.startsWith('onedrive')) ||
    insideOneDriveRoot(real, policy.oneDriveRoots);
  if (onOneDrive) throw new OutputRefusal(`${option} is inside OneDrive; use a local folder`);
  if (gitRootOf(p) !== null) {
    throw new OutputRefusal(`${option} is inside a git repository; the tool never uses one`);
  }
}

/** The staging folder is read by the lead session, which must never read ggpin-secrets (R-3). */
export function assertNotInSecrets(p: string, option: string): void {
  if (segments(realPathOf(p, option)).includes('ggpin-secrets')) {
    throw new OutputRefusal(`${option} is inside ggpin-secrets; staging must live outside it`);
  }
}

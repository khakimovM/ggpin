// One log line for any caught error. A database error is described from the allowlist of
// redactDatabaseError (its first line, names only): a Prisma validation error renders the whole
// argument of the failed call into its message, and a Postgres error may quote a value, so neither
// message is ever copied (review M1). Every other error is `name: message`, scrubbed and cut.
import { isDatabaseError, redactDatabaseError } from './db-errors';
import { scrubSecretsInText } from './text';

/** The longest description written by default (a log line, not a dump). */
export const MAX_LOGGED_ERROR_TEXT = 300;

/** How deep the `cause` chain is searched for a database error (a wrapper of a wrapper). */
const MAX_CAUSE_DEPTH = 5;

type CauseSearch = { kind: 'database'; error: Error } | { kind: 'none' } | { kind: 'too-deep' };

function searchCauses(error: Error): CauseSearch {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) return { kind: 'none' };
    if (isDatabaseError(current)) return { kind: 'database', error: current };
    current = current.cause;
  }
  // The chain goes on past the searched depth: a database error may sit further down, and each
  // wrapper may repeat its rendered text, so no message of this chain is safe to copy.
  return current instanceof Error ? { kind: 'too-deep' } : { kind: 'none' };
}

/**
 * A log-safe one-liner of `error`. When the error is, or wraps (through `cause`), a database error,
 * only the redacted database description is used, and a wrapper adds its name but never its
 * message: a wrapper's message often repeats the database text it wraps.
 */
export function describeErrorForLog(error: unknown, maxLength = MAX_LOGGED_ERROR_TEXT): string {
  if (!(error instanceof Error)) return 'non-Error thrown';
  const found = searchCauses(error);
  if (found.kind === 'too-deep') {
    return scrubSecretsInText(`${error.name}: cause chain too deep, message not logged`).slice(
      0,
      maxLength,
    );
  }
  if (found.kind === 'none') {
    return scrubSecretsInText(`${error.name}: ${error.message}`).slice(0, maxLength);
  }
  const database = found.error;
  const { name, message } = redactDatabaseError(database);
  const wrapper = database === error ? '' : `${error.name} caused by `;
  return `${wrapper}${String(name)}: ${String(message)}`.slice(0, maxLength);
}

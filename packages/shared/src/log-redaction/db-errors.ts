// Prisma and Postgres errors carry the DATA of the failed call in their text: a
// PrismaClientValidationError renders the whole argument of `tx.order.create()` (recipient,
// providerRef, cost, idempotency key) into its message and stack, and a Postgres error carries a
// `detail` such as `Failing row contains (...)` or `Key (...)=(...)`. Key-name redaction cannot see
// a value inside text, so a database error is not copied: it is rebuilt from an allowlist that
// says WHAT failed and WHERE in our code, never with which data (audit L3, review N4).
import { REDACTED } from './keys';
import { scrubSecretsInText } from './text';

/** The one line of the message that is kept: it names the failed call, not its arguments. */
export const MAX_DATABASE_ERROR_LINE = 512;

const PRISMA_ERROR = /^PrismaClient[A-Za-z]*Error$/;
const DRIVER_ADAPTER_ERROR = 'DriverAdapterError';

// Postgres classes whose message names only objects (constraint, relation, column) or is one of
// our own guard texts, never a value: 23 integrity (the values are in `detail`), 40 rollback
// (serialization, deadlock), 55 object state (lock not available), 57 operator intervention
// (timeouts, cancel), GG our guards (ids and statuses only). Every other class may quote the
// value (22P02 `invalid input syntax for type bigint: "<value>"`), so its text is hidden.
const TEXT_SAFE_SQLSTATE = /^(?:23|40|55|57|GG)[0-9A-Z]{3}$/;

// A V8 stack frame: four spaces and "at". The rendered arguments of a Prisma validation error are
// indented deeper and start with a key, so they never look like one.
const FRAME = /^ {4}at \S/;

// What the Prisma adapter and pg put next to the SQLSTATE that are names, never values.
const NAME_FACTS = ['kind', 'originalCode', 'code', 'severity', 'schema', 'table', 'column'];

type Fields = Record<string, unknown>;

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Fields)[key] : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const isNamed = (error: Error, name: string): boolean =>
  error.name === name || error.constructor.name === name;

/** A Prisma client error, a Prisma driver adapter error, or a raw `pg` DatabaseError. */
export function isDatabaseError(error: Error): boolean {
  if (PRISMA_ERROR.test(error.name) || PRISMA_ERROR.test(error.constructor.name)) return true;
  if (isNamed(error, DRIVER_ADAPTER_ERROR)) return true;
  return (
    error.constructor.name === 'DatabaseError' &&
    typeof field(error, 'severity') === 'string' &&
    typeof field(error, 'code') === 'string'
  );
}

// Where the Postgres facts are: under the Prisma error's meta, as the adapter error's cause, or
// (a raw pg error) on the error itself.
function postgresFacts(error: Error): unknown {
  if (isNamed(error, DRIVER_ADAPTER_ERROR)) return error.cause;
  if (error.constructor.name === 'DatabaseError') return error;
  return field(field(field(error, 'meta'), 'driverAdapterError'), 'cause');
}

function names(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((name) => typeof name === 'string')) return [...value];
  return undefined;
}

// The adapter gives `{ index }` or `{ fields }` (column names), pg the constraint name.
function constraintOf(value: unknown): unknown {
  if (typeof value === 'string') return value;
  const index = text(field(value, 'index'));
  if (index !== undefined) return { index };
  const fields = names(field(value, 'fields'));
  return Array.isArray(fields) ? { fields } : undefined;
}

function safeFacts(facts: unknown, pgMessage: string | undefined): Fields | undefined {
  if (typeof facts !== 'object' || facts === null) return undefined;
  const out: Fields = {};
  for (const name of NAME_FACTS) {
    const value = text(field(facts, name));
    if (value !== undefined) out[name] = scrubSecretsInText(value, MAX_DATABASE_ERROR_LINE);
  }
  const constraint = constraintOf(field(facts, 'constraint'));
  if (constraint !== undefined) out.constraint = constraint;
  if (pgMessage !== undefined) out.message = scrubSecretsInText(pgMessage, MAX_DATABASE_ERROR_LINE);
  return out;
}

function firstLine(message: string): string {
  return message.split('\n').find((line) => line.trim() !== '') ?? '';
}

// The frames after the message (the message itself may span many lines of rendered data).
function framesOf(error: Error): string[] {
  const stack = error.stack ?? '';
  const at = error.message === '' ? -1 : stack.indexOf(error.message);
  const tail = at === -1 ? stack : stack.slice(at + error.message.length);
  return tail
    .split('\n')
    .filter((line) => FRAME.test(line))
    .map((line) => scrubSecretsInText(line, MAX_DATABASE_ERROR_LINE));
}

function metaOf(error: Error, facts: Fields | undefined): Fields | undefined {
  const meta = field(error, 'meta');
  if (typeof meta !== 'object' || meta === null) return undefined;
  const out: Fields = {};
  for (const name of ['modelName', 'table', 'target']) {
    const value = names(field(meta, name));
    if (value !== undefined) out[name] = value;
  }
  if (facts !== undefined) out.driverAdapterError = { name: DRIVER_ADAPTER_ERROR, cause: facts };
  return out;
}

/**
 * A database error as it may be logged: type, name, Prisma `code` / `errorCode`, `clientVersion`,
 * the first line of the message, the stack frames, `meta.modelName` and the Postgres facts that
 * are names (kind, SQLSTATE, severity, constraint, table, column). Dropped: the rest of the message
 * and stack (a validation error's rendered `data`), `detail`, `hint`, `where`, the query, and the
 * Postgres message of every class that may quote a value (also cut out of the first line).
 */
export function redactDatabaseError(error: Error): Fields {
  const facts = postgresFacts(error);
  const sqlState = text(field(facts, 'originalCode')) ?? text(field(facts, 'code'));
  const textSafe = sqlState !== undefined && TEXT_SAFE_SQLSTATE.test(sqlState);
  const pgMessage = text(field(facts, 'originalMessage')) ?? text(field(facts, 'message'));
  let headline = firstLine(error.message);
  if (!textSafe && pgMessage !== undefined && pgMessage !== '') {
    headline = headline.split(pgMessage).join(REDACTED);
  }
  const message = scrubSecretsInText(headline, MAX_DATABASE_ERROR_LINE);
  const out: Fields = {
    type: error.constructor.name,
    name: error.name,
    message,
    stack: [`${error.name}: ${message}`, ...framesOf(error)].join('\n'),
  };
  for (const name of ['code', 'errorCode', 'clientVersion']) {
    const value = text(field(error, name));
    if (value !== undefined) out[name] = value;
  }
  const kept = safeFacts(facts, textSafe ? pgMessage : undefined);
  if (error.constructor.name === 'DatabaseError') {
    Object.assign(out, kept);
    return out;
  }
  const meta = metaOf(error, kept);
  if (meta !== undefined) out.meta = meta;
  else if (kept !== undefined) out.cause = kept; // a DriverAdapterError: its cause is the facts
  return out;
}

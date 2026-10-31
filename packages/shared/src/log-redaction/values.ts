// One redaction policy for every log line the api and the worker write (AC5: secrets never
// reach log output). Dependency-free on purpose: both apps plug these functions into Pino.
//
// Why a deep copy and not Pino's `redact` option: `redact` paths have a fixed depth
// ("a.b.c") or one wildcard level, so `{ payment: { meta: { signature } } }` or a header map
// logged under an unknown key would slip through. Matching key NAMES at any depth is the
// stronger guarantee. The copy never mutates the caller's object (it may be a live request,
// config or domain object), handles cycles and Errors, and is bounded in depth.
import { REDACTED, isSensitiveField } from './keys';
import { scrubSecretsInText } from './text';

const CIRCULAR = '[Circular]';
const TRUNCATED = '[Truncated]';
const UNSERIALIZABLE = '[Unserializable]';

/** Deeper structures are cut off: bounds the cost of logging a huge graph by mistake. */
export const MAX_REDACTION_DEPTH = 8;

// ---- Values -----------------------------------------------------------------------------

type Ancestors = Set<object>;

// `__proto__` can arrive as an own key of a parsed JSON body; a plain assignment would swap
// the copy's prototype instead of adding a property.
function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) return;
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

function copyProperties(
  source: Readonly<Record<string, unknown>>,
  depth: number,
  ancestors: Ancestors,
  passthrough?: ReadonlySet<string>,
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (passthrough?.has(key) === true) {
      assign(copy, key, value);
    } else if (isSensitiveField(key, value) && value !== null && value !== undefined) {
      assign(copy, key, REDACTED);
    } else {
      assign(copy, key, redactValue(value, depth + 1, ancestors));
    }
  }
  return copy;
}

// Error fields (message, stack, cause) are non-enumerable, so a plain copy would log `{}`.
function copyError(error: Error, depth: number, ancestors: Ancestors): Record<string, unknown> {
  const copy: Record<string, unknown> = {
    type: error.constructor.name,
    message: scrubSecretsInText(error.message),
  };
  if (error.stack !== undefined) copy.stack = scrubSecretsInText(error.stack);
  // Own enumerable extras (`code`, `statusCode`, `response`, ...) go through the key policy.
  const extras = copyProperties(error as unknown as Record<string, unknown>, depth, ancestors);
  for (const key of Object.keys(extras)) assign(copy, key, extras[key]);
  if (error.cause !== undefined) copy.cause = redactValue(error.cause, depth + 1, ancestors);
  if (error instanceof AggregateError) {
    copy.errors = redactValue(error.errors, depth + 1, ancestors);
  }
  return copy;
}

function copyObject(value: object, depth: number, ancestors: Ancestors): unknown {
  if (value instanceof Error) return copyError(value, depth, ancestors);
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactValue(item, depth + 1, ancestors));
  }
  if (value instanceof Date) return value;
  // Binary data is never worth logging and could be key material.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[Binary ${String(value.byteLength)} bytes]`;
  }
  if (value instanceof Set) return redactValue([...value], depth, ancestors);
  if (value instanceof Map) {
    const entries: Record<string, unknown> = {};
    for (const [key, entry] of value) entries[String(key)] = entry;
    return copyProperties(entries, depth, ancestors);
  }
  if ('toJSON' in value && typeof value.toJSON === 'function') {
    const json: unknown = Reflect.apply(value.toJSON, value, []);
    return redactValue(json, depth + 1, ancestors);
  }
  return copyProperties(value as Record<string, unknown>, depth, ancestors);
}

function redactValue(value: unknown, depth: number, ancestors: Ancestors): unknown {
  if (typeof value === 'string') return scrubSecretsInText(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined; // JSON drops them
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_REDACTION_DEPTH) return TRUNCATED;
  // Ancestors, not "everything seen": the same object referenced twice is not a cycle.
  if (ancestors.has(value)) return CIRCULAR;
  ancestors.add(value);
  try {
    return copyObject(value, depth, ancestors);
  } catch {
    return UNSERIALIZABLE; // a throwing getter or toJSON must not break logging
  } finally {
    ancestors.delete(value);
  }
}

/** Deep copy of `value` with secret-bearing keys replaced and secrets in text scrubbed. */
export function redactSecrets(value: unknown): unknown {
  return redactValue(value, 0, new Set());
}

/**
 * For Pino's `formatters.log`: redacts the fields of one log record. `passthroughKeys` are
 * left to their own serializers (`req`, `res`, `err`), which hold live objects that are not
 * worth deep-copying here.
 */
export function redactLogRecord(
  record: Readonly<Record<string, unknown>>,
  passthroughKeys?: ReadonlySet<string>,
): Record<string, unknown> {
  return copyProperties(record, 0, new Set([record]), passthroughKeys);
}

/**
 * Redacts the pre-serialised bindings string Pino keeps for a logger (`,"k":v,"k2":v2`).
 * Fails closed: text that is not the expected JSON fragment is dropped, not passed through.
 */
export function redactSerializedBindings(chindings: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(`{${chindings.replace(/^,/, '')}}`);
  } catch {
    return '';
  }
  const json = JSON.stringify(redactSecrets(parsed));
  return json === '{}' ? '' : `,${json.slice(1, -1)}`;
}

/**
 * For Pino's `onChild`: Pino resets `formatters.bindings` for child loggers, so
 * `logger.child({ apiKey })` would print the key on every line the child writes. Rewrites the
 * child's stored bindings through the redaction policy. `chindingsSym` is `pino.symbols.chindingsSym`
 * (public Pino API); passing it in keeps this package free of a Pino dependency.
 */
export function redactChildBindings(child: object, chindingsSym: symbol): void {
  const current: unknown = Reflect.get(child, chindingsSym);
  if (typeof current === 'string') {
    Reflect.set(child, chindingsSym, redactSerializedBindings(current));
  }
}

import { Readable } from 'node:stream';

// Objects whose own serialisation we must not second-guess: Date and Decimal-like values
// define toJSON; Buffers/typed arrays and streams are binary payloads, not data trees.
function isOpaque(value: object): boolean {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return true;
  }
  if (value instanceof Readable) return true;
  return 'toJSON' in value && typeof value.toJSON === 'function';
}

/**
 * Deep copy of a response value in which every BigInt is a decimal string
 * (CLAUDE.md §5.1: JSON carries money as strings; JSON.stringify throws on BigInt).
 * Arrays and objects are rebuilt; Date and other `toJSON` values, Buffers and streams pass
 * through untouched. Cyclic structures are not supported (they would not serialise anyway).
 */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (isOpaque(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonSafe(item)]));
}

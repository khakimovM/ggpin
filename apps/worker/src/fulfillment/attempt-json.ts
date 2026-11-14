import type { Prisma } from '@repo/db';
import type { AttemptJson } from '../adapters/fulfillment-adapter';

// FulfillmentAttempt.request / response are JSON columns. Adapters hand over AttemptJson (readonly,
// JSON-safe by type); Prisma wants its own input shape. Converted structurally, without a cast,
// and always as an object at the top level (`request` is NOT NULL, a bare value is wrapped).

type InputValue = Prisma.InputJsonValue | null;

function convert(value: AttemptJson): InputValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item: AttemptJson) => convert(item));
  const out: Record<string, InputValue> = {};
  for (const [key, item] of Object.entries(value)) out[key] = convert(item);
  return out;
}

export function toAttemptJson(value: AttemptJson): Prisma.InputJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { value: convert(value) };
  }
  const out: Record<string, InputValue> = {};
  for (const [key, item] of Object.entries(value)) out[key] = convert(item);
  return out;
}

/** The stored JSON object of a column, or an empty one (a missing or non-object response). */
export function storedObject(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

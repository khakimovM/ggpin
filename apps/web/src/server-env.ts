import { baseUrl } from './env-schema';
import { z } from 'zod';

// Server-only configuration: read with `process.env` at call time, never `NEXT_PUBLIC_`, so Next.js
// does not inline it into a browser bundle. It is not a secret (it is an internal URL), but there
// is no reason for the browser to learn where the API listens inside our network. Client code must
// not import this module; the client uses `env.NEXT_PUBLIC_API_URL`.

const schema = z.object({
  // Where the Next.js SERVER reaches the API (Docker: http://api:5000/api/v1). Empty or unset means
  // "use the public API URL", which is right for local development. The same shape rules as the
  // public URLs: http(s), no query, hash or credentials, no trailing slash.
  API_INTERNAL_URL: z.union([z.literal(''), baseUrl]),
});

export type ServerEnv = { API_INTERNAL_URL: string };

export interface RawServerEnv {
  API_INTERNAL_URL?: string | undefined;
}

/** Validates the server-only variables; throws on a bad value (the caller decides what to do). */
export function parseServerEnv(raw: RawServerEnv): ServerEnv {
  return schema.parse({ API_INTERNAL_URL: raw.API_INTERNAL_URL?.trim() ?? '' });
}

/**
 * The API base URL for requests made by the Next.js server: `API_INTERNAL_URL` when set, otherwise
 * the public one. `publicApiUrl` is the already validated `NEXT_PUBLIC_API_URL`.
 */
export function resolveApiBaseUrl(raw: RawServerEnv, publicApiUrl: string): string {
  const { API_INTERNAL_URL } = parseServerEnv(raw);
  return API_INTERNAL_URL === '' ? publicApiUrl : API_INTERNAL_URL;
}

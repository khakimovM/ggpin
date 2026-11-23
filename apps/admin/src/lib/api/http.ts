// The one place that turns "call this admin endpoint" into a validated result (docs/04 "Admin").
// The session is an httpOnly cookie the browser attaches (transport.ts); this layer adds the CSRF
// header to writes and turns "the session is gone" (a 404, D-26) into a sign-out.
import { CSRF_HEADER, IdempotencyKeySchema, type PageMeta } from '@repo/shared';
import { z } from 'zod';
import type { MockGroupName } from '../../env-schema';
import { errorFromResponse, parseResponse } from './envelope';
import { ApiError } from './errors';
import type { HttpMethod, Transport, TransportRequest, TransportResponse } from './transport';
import { sendWithTimeout } from './write-timeout';

/** The session probe: a live session answers 200, a dead or missing one 404. */
export const ME_PATH = '/admin/auth/me';

type QueryValue = string | number | boolean | undefined;

export interface AdminRequest {
  /** Defaults to GET. */
  method?: HttpMethod;
  /** Path below the API base URL, starting with a slash: `/admin/auth/me`. */
  path: string;
  query?: Readonly<Record<string, QueryValue>>;
  body?: unknown;
  /** Required by the API on every admin write except auth and confirmations. */
  idempotencyKey?: string;
  /**
   * `session` (default): a 404 may mean the session is gone, and is checked. `none`: the open
   * login routes, where a 404 is about the login request itself (an expired nonce).
   */
  session?: 'session' | 'none';
  /** The mock group of the endpoint; the real transport is used unless that group is mocked. */
  group?: MockGroupName;
  signal?: AbortSignal;
}

export interface AdminHttpDeps {
  baseUrl: string;
  transportFor: (group: MockGroupName | undefined) => Promise<Transport>;
  /** The session is gone: clear private data and show the login page. */
  onSessionLost: () => void;
  now?: () => number;
}

export interface AdminHttp {
  fetch: <S extends z.ZodType>(request: AdminRequest, schema: S) => Promise<z.infer<S>>;
  fetchList: <S extends z.ZodType>(
    request: AdminRequest,
    itemSchema: S,
  ) => Promise<{ items: z.infer<S>[]; meta: PageMeta }>;
  /** A non-JSON 2xx body (the audit CSV export); failures still arrive in the JSON envelope. */
  fetchText: (request: AdminRequest) => Promise<string>;
}

function serialiseQuery(query: AdminRequest['query']): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * Every write carries `X-CSRF-Token` (the API refuses a write without it, and a cross-site page
 * cannot add the header without a preflight the admin CORS policy refuses). Its value is not a
 * secret: the protection is the header plus `Origin === ADMIN_URL`, both checked by the API.
 */
export function buildRequest(baseUrl: string, request: AdminRequest): TransportRequest {
  const method = request.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers[CSRF_HEADER] = '1';
  if (request.body !== undefined) headers['content-type'] = 'application/json';
  if (request.idempotencyKey !== undefined) {
    const key = IdempotencyKeySchema.safeParse(request.idempotencyKey);
    if (!key.success) throw new ApiError({ status: 400, code: 'VALIDATION_ERROR' });
    headers['idempotency-key'] = key.data;
  }
  return {
    method,
    url: `${baseUrl}${request.path}${serialiseQuery(request.query)}`,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: request.signal,
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function send(transport: Transport, request: TransportRequest): Promise<TransportResponse> {
  try {
    return await transport(request);
  } catch (error) {
    // A cancelled query is not a failure: TanStack Query must see the abort.
    if (isAbort(error)) throw error;
    throw new ApiError({ status: 0, code: 'NETWORK' });
  }
}

export function createAdminHttp(deps: AdminHttpDeps): AdminHttp {
  const now = deps.now ?? Date.now;
  let probe: Promise<boolean> | null = null;

  // Whether the session is still alive, asked once for any number of 404s arriving together.
  // Only a definite 404 from the probe counts as "gone": a network error or a 5xx says nothing.
  function sessionGone(): Promise<boolean> {
    probe ??= (async () => {
      try {
        const transport = await deps.transportFor('auth');
        // F-2: the probe may follow a keyed write's 404, so it must not hang that form either. A
        // timeout throws and counts as "unknown" (false), never as "gone".
        const response = await sendWithTimeout(
          (request) => send(transport, request),
          buildRequest(deps.baseUrl, { path: ME_PATH }),
        );
        return response.status === 404;
      } catch {
        return false;
      } finally {
        probe = null;
      }
    })();
    return probe;
  }

  async function respond(request: AdminRequest): Promise<TransportResponse> {
    const transport = await deps.transportFor(request.group);
    const built = buildRequest(deps.baseUrl, request);
    // N-1: a keyed write never waits forever; its timeout is an unknown outcome like no answer.
    const response =
      request.idempotencyKey === undefined
        ? await send(transport, built)
        : await sendWithTimeout((r) => send(transport, r), built);
    // D-26: the admin API answers every refusal with the same 404, a missing session included.
    // On `me` that is the answer itself; elsewhere the 404 may also be a missing record or a role
    // that lacks the right, so the session is asked before signing out.
    if (response.status === 404 && (request.session ?? 'session') === 'session') {
      const gone = request.path === ME_PATH || (await sessionGone());
      if (gone) deps.onSessionLost();
    }
    return response;
  }

  async function execute<S extends z.ZodType>(request: AdminRequest, schema: S) {
    return parseResponse(await respond(request), schema, now());
  }

  return {
    fetch: async (request, schema) => (await execute(request, schema)).data,
    fetchList: async (request, itemSchema) => {
      const { data, meta } = await execute(request, z.array(itemSchema));
      if (meta === undefined) throw new ApiError({ status: 200, code: 'INTERNAL_ERROR' });
      return { items: data, meta };
    },
    fetchText: async (request) => {
      const response = await respond(request);
      if (response.status < 200 || response.status >= 300) {
        throw errorFromResponse(response, now());
      }
      return response.text ?? '';
    },
  };
}

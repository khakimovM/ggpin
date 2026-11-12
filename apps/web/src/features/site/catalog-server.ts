import {
  CatalogProductDetailSchema,
  CatalogProductListItemSchema,
  SlugSchema,
  type CatalogProductDetail,
  type CatalogProductListItem,
  type Locale,
} from '@repo/shared';
import { unstable_rethrow } from 'next/navigation';
import { z } from 'zod';
import { env } from '../../env';
import { resolveApiBaseUrl } from '../../server-env';

// Server-side reader of the public catalog (docs/04 "Katalog") for the marketing pages.
//
// Rules that make it safe to put on a landing page:
//  - the page must render whatever the API does, so every failure ends as "no data" (null), never
//    as an exception; the page then shows itself without prices;
//  - at most 3 seconds are spent on the API, so a slow API cannot stall the page or its crawler;
//  - the answer sits in the Next.js data cache for 60 s (the API sends `max-age=60` too), so a page
//    view is not an API request;
//  - the body is validated with the shared Zod schemas; a payload that does not match is treated
//    as an outage, and is never logged (it may carry anything);
//  - the browser-side client and its mock transport are deliberately NOT imported here.
// Next.js behaviour that shapes how a page must use this (verified in next 15.5 patch-fetch):
//  - when it refreshes a stale entry in the background it drops the `signal`, and it stores only a
//    200 answer. With the API down and nothing cached, every page view therefore waits the full
//    3 seconds. The product block of a page MUST sit inside <Suspense> (phase 8 S2), so the hero
//    and the rest of the page do not wait for it.
// Prices are passed on exactly as the server sent them (tiyin strings or null): nothing is
// computed in this module.

const TIMEOUT_MS = 3_000;
export const CATALOG_REVALIDATE_SECONDS = 60;
// The list endpoint allows at most 100 per page (CATALOG_MAX_LIMIT); the catalog is far below that.
const LIST_LIMIT = 100;

type Failure = 'TIMEOUT' | 'NETWORK' | 'CONFIG' | 'BAD_BODY' | `HTTP_${number}`;

type Outcome<T> =
  { kind: 'ok'; data: T } | { kind: 'not-found' } | { kind: 'unavailable'; failure: Failure };

// Only a short code goes to the log: no URL, no body, no error message.
function report(failure: Failure): void {
  console.error(`[site-catalog] ${failure}`);
}

function failureOf(error: unknown): Failure {
  // Not `instanceof Error`: a DOMException from another realm is not one.
  const name: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'name') : undefined;
  return name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
}

async function read<S extends z.ZodType>(
  path: string,
  query: Record<string, string | number>,
  schema: S,
): Promise<Outcome<z.infer<S>>> {
  let base: string;
  try {
    base = resolveApiBaseUrl(
      { API_INTERNAL_URL: process.env.API_INTERNAL_URL },
      env.NEXT_PUBLIC_API_URL,
    );
  } catch {
    report('CONFIG');
    return { kind: 'unavailable', failure: 'CONFIG' };
  }

  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate: CATALOG_REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // Next.js uses thrown errors for its own control flow (a dynamic-rendering bailout, a redirect):
    // those must keep travelling, only real failures of the request are "no data".
    unstable_rethrow(error);
    const failure = failureOf(error);
    report(failure);
    return { kind: 'unavailable', failure };
  }

  if (response.status === 404) return { kind: 'not-found' };
  if (!response.ok) {
    const failure: Failure = `HTTP_${response.status}`;
    report(failure);
    return { kind: 'unavailable', failure };
  }

  try {
    const body: unknown = await response.json();
    const envelope = z.object({ success: z.literal(true), data: z.unknown() }).safeParse(body);
    const data = envelope.success ? schema.safeParse(envelope.data.data) : null;
    if (data?.success) return { kind: 'ok', data: data.data };
  } catch (error) {
    unstable_rethrow(error);
    // An unreadable body is reported below, like one that fails validation.
  }
  report('BAD_BODY');
  return { kind: 'unavailable', failure: 'BAD_BODY' };
}

/** Active products for the landing and the catalog teasers; `null` when the API cannot be used. */
export async function getSiteProducts(locale: Locale): Promise<CatalogProductListItem[] | null> {
  const outcome = await read(
    '/catalog/products',
    { locale, limit: LIST_LIMIT },
    CatalogProductListItemSchema.array(),
  );
  return outcome.kind === 'ok' ? outcome.data : null;
}

export type SiteProductLookup =
  | { status: 'ok'; product: CatalogProductDetail }
  | { status: 'not-found' }
  | { status: 'unavailable' };

/**
 * One product, told apart: the API answered 404 (the product is gone: say so) or could not be used
 * (say nothing about the product: show the page without prices).
 */
export async function lookupSiteProduct(slug: string, locale: Locale): Promise<SiteProductLookup> {
  // A slug the API would refuse is not sent at all (and cannot alter the request path).
  if (!SlugSchema.safeParse(slug).success) return { status: 'not-found' };
  const outcome = await read(`/catalog/products/${slug}`, { locale }, CatalogProductDetailSchema);
  if (outcome.kind === 'ok') return { status: 'ok', product: outcome.data };
  return outcome.kind === 'not-found' ? { status: 'not-found' } : { status: 'unavailable' };
}

/** One product, or `null` when it does not exist or the API cannot be used. */
export async function getSiteProduct(
  slug: string,
  locale: Locale,
): Promise<CatalogProductDetail | null> {
  const lookup = await lookupSiteProduct(slug, locale);
  return lookup.status === 'ok' ? lookup.product : null;
}

import { QuoteResponseSchema, type CreateQuoteBody, type QuoteResponse } from '@repo/shared';
import { apiFetch } from './client';

/** The only source of a price the user pays: the server computes and locks it. */
export function createQuote(body: CreateQuoteBody, signal?: AbortSignal): Promise<QuoteResponse> {
  return apiFetch(
    { method: 'POST', path: '/quotes', body, group: 'quotes', signal },
    QuoteResponseSchema,
  );
}

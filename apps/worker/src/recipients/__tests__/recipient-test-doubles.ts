import type { AdapterHealth, RecipientCheckResult } from '@repo/shared';
import type { FulfillmentAdapter, ProductRef } from '../../adapters/fulfillment-adapter';

// Stand-in adapters for the validate-recipient tests: only `validateRecipient` and `health` are
// meant to be reached; everything that could move value rejects.

export interface StubAdapterOptions {
  readonly health?: () => Promise<AdapterHealth>;
  readonly validate?: (
    product: ProductRef,
    input: Readonly<Record<string, string>>,
  ) => Promise<unknown>;
}

const notHere = (): Promise<never> =>
  Promise.reject(new Error('a validate-recipient stub adapter was asked to do more'));

export function stubAdapter(code: string, options: StubAdapterOptions = {}): FulfillmentAdapter {
  return {
    code,
    validateRecipient: (product, input) =>
      (options.validate ?? (() => Promise.resolve({ status: 'NOT_FOUND' })))(
        product,
        input,
      ) as Promise<RecipientCheckResult>,
    quote: notHere,
    prepare: notHere,
    send: notHere,
    confirm: notHere,
    getBalance: notHere,
    health: options.health ?? (() => Promise.resolve('OK')),
  };
}

/** The tgUsername form of a Stars-like product (Product.inputSchema). */
export const TG_USERNAME_FORM = [
  { key: 'username', type: 'tgUsername', label: 'fields.tgUsername' },
] as const;

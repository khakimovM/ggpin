import {
  OrderDetailSchema,
  OrderSchema,
  QuoteResponseSchema,
  ValidateRecipientResponseSchema,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { MOCK_RECIPIENT, mockOrder, mockOrderDetail, mockQuote } from '../mock/fixtures/orders';

const NOW = new Date('2026-11-05T10:00:00.000Z');

// The wallet and payments mocks are gone (phase 4 is real); their values live in
// payment-fixtures.ts and are checked in payments-fixtures.test.ts.
describe('mock fixtures pass their shared schemas', () => {
  it.each([
    ['recipient', ValidateRecipientResponseSchema, MOCK_RECIPIENT],
    ['quote', QuoteResponseSchema, mockQuote(NOW)],
    ['order', OrderSchema, mockOrder('PAID', NOW)],
    ['order detail (delivered)', OrderDetailSchema, mockOrderDetail('DELIVERED', NOW)],
    ['order detail (failed)', OrderDetailSchema, mockOrderDetail('FAILED', NOW)],
  ] as const)('%s', (_name, schema, value) => {
    expect(() => (schema as z.ZodType).parse(value)).not.toThrow();
  });
});

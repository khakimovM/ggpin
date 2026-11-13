import {
  resolveNeedsReviewAt,
  type ResolveNeedsReviewInput,
} from '../src/orders/needs-review-resolve';
import { db } from './client';
import { NOW } from './order-fixtures';

export type ResolveInput = ResolveNeedsReviewInput;

/**
 * `resolveNeedsReview` with the clock of the tests (`NOW`, after every proof time): the public
 * helper reads the database's own clock and takes none (audit N2), so the tests reach the clock
 * through the internal entry point.
 */
export const resolve = (input: ResolveInput, clock: Date = NOW) =>
  db.$transaction((tx) => resolveNeedsReviewAt(tx, input, clock));

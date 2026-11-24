import { PaymentMethodsResponseSchema } from '@repo/shared';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { startRealApi, type RunningApi } from './real-api';
import { nextTelegramId, parsed, send, signInReal, type Session } from './real-http';
import { createTestCard, retireTestCard, type TestCard } from './real-topup';

// The set-up and tear-down every top-up spec of the `real-api` project shares: the real API and
// worker, one synthetic ACTIVE Humo card, and at the end the card RETIRED and the stack stopped
// (even when retiring fails), with the loopback guard's verdict asserted last.

export interface RealStack {
  /** The card of this run (tests run only after the hook created it). */
  card: () => TestCard;
}

export function setUpRealStack(): RealStack {
  let stack: RunningApi | undefined;
  let card: TestCard | undefined;

  test.beforeAll(async ({ request }) => {
    // Starting waits for the lock when another spec file holds the stack.
    test.setTimeout(180_000);
    stack = await startRealApi({ worker: true });
    card = await createTestCard('HUMO');
    await bankFeedAlive(request);
  });

  test.afterAll(async () => {
    let refused: string[] = [];
    try {
      if (card !== undefined) await retireTestCard(card);
    } finally {
      if (stack !== undefined) {
        refused = stack.guardHits();
        await stack.stop();
      }
    }
    // A connection to anything but this machine would have been refused and written down.
    expect(refused).toEqual([]);
  });

  return {
    card: () => {
      if (card === undefined) throw new Error('the test card was not created');
      return card;
    },
  };
}

/**
 * Waits until the API hands out card requests. "worker started" comes before the bank-feed
 * listener's first poll, and until its heartbeat is in Redis `POST /payments/intents` answers
 * 503 PAYMENT_METHOD_UNAVAILABLE (fail closed): a spec whose first test creates a request lost
 * that race in CI and passed only on retry.
 */
async function bankFeedAlive(request: APIRequestContext): Promise<void> {
  const probe = await newPayer(request);
  await expect
    .poll(
      async () => {
        const response = await send(request, 'GET', '/payments/methods', { session: probe });
        if (response.status !== 200) return false;
        return parsed(response, PaymentMethodsResponseSchema).data[0]?.available === true;
      },
      { timeout: 45_000, message: 'the worker bank-feed listener never became alive' },
    )
    .toBe(true);
}

/** A new payer (a new account, with its own limits and no earlier requests). */
export const newPayer = (
  request: APIRequestContext,
  language: 'uz' | 'ru' = 'uz',
): Promise<Session> => signInReal(request, nextTelegramId(), language);

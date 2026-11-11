import { randomBytes } from 'node:crypto';
import { AppError } from '../../../common/exceptions/app-error';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import type { FixedWindowCounter } from '../../../infra/redis/fixed-window-counter';
import { hashPayToken } from '../pay-token';
import { PayViewService } from '../pay-view.service';
import type { PayDetails, PayGate, TopupIntentsRepository } from '../topup-intents.repository';
import { cardRow } from './payments.fixtures';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const ID = 'cm3intent0000000000000001';
const env = buildTestEnv();
const token = randomBytes(32).toString('base64url');
const hashOf = (value: string) => hashPayToken(env.PAY_TOKEN_PEPPER, ID, value);

function gate(overrides: Partial<PayGate> = {}): PayGate {
  return {
    id: ID,
    provider: 'P2P_CARD',
    status: 'PENDING',
    expiresAt: new Date(NOW.getTime() + 600_000),
    payTokenHash: hashOf(token),
    userId: 'u1',
    ...overrides,
  };
}

function details(overrides: Partial<PayDetails> = {}): PayDetails {
  return {
    ...gate(),
    amountTiyin: 2_000_100n,
    baseAmountTiyin: 2_000_000n,
    purpose: 'TOPUP',
    quoteId: null,
    idempotencyKey: 'key-00000001',
    requestHash: 'h',
    cardId: 'card_a',
    paidAt: null,
    reservedUntil: new Date(NOW.getTime() + 86_400_000),
    createdAt: NOW,
    updatedAt: NOW,
    card: cardRow(),
    user: { firstName: 'Sardor', username: null, isBlocked: false },
    ...overrides,
  };
}

function setup(row: PayGate | null, full: PayDetails | null = details()) {
  const repo = {
    findPayGate: jest.fn((): Promise<PayGate | null> => Promise.resolve(row)),
    findPayDetails: jest.fn((): Promise<PayDetails | null> => Promise.resolve(full)),
  };
  const counter = { hit: jest.fn(() => Promise.resolve({ count: 1, ttlSec: 60 })) };
  const service = new PayViewService(
    repo as unknown as TopupIntentsRepository,
    counter as unknown as FixedWindowCounter,
    env,
    { now: () => NOW },
  );
  return { service, repo, counter };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof AppError)) throw new Error('expected an AppError');
  return error.code;
}

describe('PayViewService.read (D-39)', () => {
  it('the right token: card and owner are loaded only now, and the view is served', async () => {
    const { service, repo } = setup(gate());
    const view = await service.read(ID, token);
    expect(view.intentId).toBe(ID);
    expect(repo.findPayDetails).toHaveBeenCalledWith(ID);
  });

  it.each<[string, string, string | undefined, PayGate | null]>([
    ['wrong token', ID, randomBytes(32).toString('base64url'), gate()],
    ['no token', ID, undefined, gate()],
    ['malformed token', ID, 'short', gate()],
    ['unknown id', ID, token, null],
    ['malformed id', 'not-an-id!', token, gate()],
    ['cancelled (hash removed)', ID, token, gate({ status: 'CANCELLED', payTokenHash: null })],
    ['cancelled with a hash left', ID, token, gate({ status: 'CANCELLED' })],
    ['expired', ID, token, gate({ expiresAt: NOW })],
  ])('%s: 404, and the card and owner are never read (R-4)', async (_name, id, value, row) => {
    const { service, repo, counter } = setup(row);
    expect(await codeOf(service.read(id, value))).toBe('NOT_FOUND');
    expect(repo.findPayGate).toHaveBeenCalledTimes(1);
    expect(repo.findPayDetails).not.toHaveBeenCalled();
    expect(counter.hit).not.toHaveBeenCalled();
  });

  it('a token rotated between the two reads: step 2 checks the hash again, 404 (n2)', async () => {
    const rotated = details({ payTokenHash: hashOf(randomBytes(32).toString('base64url')) });
    const { service, counter } = setup(gate(), rotated);
    expect(await codeOf(service.read(ID, token))).toBe('NOT_FOUND');
    expect(counter.hit).not.toHaveBeenCalled();
  });

  it('cancelled or owner blocked between the two reads: 404', async () => {
    for (const full of [
      details({ status: 'CANCELLED', payTokenHash: null }),
      details({ user: { firstName: 'Sardor', username: null, isBlocked: true } }),
      null,
    ]) {
      const { service } = setup(gate(), full);
      expect(await codeOf(service.read(ID, token))).toBe('NOT_FOUND');
    }
  });
});

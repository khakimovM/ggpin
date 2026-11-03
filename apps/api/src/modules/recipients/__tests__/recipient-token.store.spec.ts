import { createHash } from 'node:crypto';
import { RECIPIENT_TOKEN_PATTERN, RECIPIENT_TOKEN_TTL_MS, type Recipient } from '@repo/shared';
import type { RedisService } from '../../../infra/redis/redis.service';
import { RecipientTokenStore, recipientTokenKey } from '../recipient-token.store';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const RECIPIENT: Recipient = { username: 'aziz_k', displayName: 'Aziz' };

interface SetCall {
  readonly key: string;
  readonly value: string;
  readonly mode: string;
  readonly ttl: number;
}

function setup() {
  const data = new Map<string, string>();
  const sets: SetCall[] = [];
  const client = {
    set: jest.fn((key: string, value: string, mode: string, ttl: number) => {
      sets.push({ key, value, mode, ttl });
      data.set(key, value);
      return Promise.resolve('OK');
    }),
    get: jest.fn((key: string) => Promise.resolve(data.get(key) ?? null)),
  };
  const redis = { client } as unknown as RedisService;
  return { store: new RecipientTokenStore(redis, { now: () => NOW }), data, sets, client };
}

describe('RecipientTokenStore.issue', () => {
  it('returns a 43-char base64url token, different every time', async () => {
    const { store } = setup();
    const a = await store.issue('u1', 'p1', RECIPIENT);
    const b = await store.issue('u1', 'p1', RECIPIENT);
    expect(a).toMatch(RECIPIENT_TOKEN_PATTERN);
    expect(b).toMatch(RECIPIENT_TOKEN_PATTERN);
    expect(a).not.toBe(b);
  });

  it('stores the record under the SHA-256 of the token with a 600 s TTL', async () => {
    const { store, sets } = setup();
    const token = await store.issue('u1', 'p1', RECIPIENT);
    const expectedKey = `rcpt:${createHash('sha256').update(token).digest('hex')}`;
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ key: expectedKey, mode: 'PX', ttl: RECIPIENT_TOKEN_TTL_MS });
    expect(RECIPIENT_TOKEN_TTL_MS).toBe(600_000);
    expect(JSON.parse(sets[0]?.value ?? '')).toEqual({
      userId: 'u1',
      productId: 'p1',
      recipient: RECIPIENT,
      issuedAt: NOW.toISOString(),
    });
  });

  it('never puts the raw token in the Redis key or value', async () => {
    const { store, sets } = setup();
    const token = await store.issue('u1', 'p1', RECIPIENT);
    for (const call of sets) {
      expect(call.key).not.toContain(token);
      expect(call.value).not.toContain(token);
    }
  });
});

describe('RecipientTokenStore.resolve', () => {
  it('returns the record for the owner and the product it was issued for', async () => {
    const { store } = setup();
    const token = await store.issue('u1', 'p1', RECIPIENT);
    await expect(store.resolve(token, 'u1', 'p1')).resolves.toEqual({
      userId: 'u1',
      productId: 'p1',
      recipient: RECIPIENT,
      issuedAt: NOW.toISOString(),
    });
  });

  it('is not consumed: a second resolve still works', async () => {
    const { store } = setup();
    const token = await store.issue('u1', 'p1', RECIPIENT);
    await store.resolve(token, 'u1', 'p1');
    await expect(store.resolve(token, 'u1', 'p1')).resolves.not.toBeNull();
  });

  it('is null for another user, another product, and an unknown token', async () => {
    const { store } = setup();
    const token = await store.issue('u1', 'p1', RECIPIENT);
    await expect(store.resolve(token, 'u2', 'p1')).resolves.toBeNull();
    await expect(store.resolve(token, 'u1', 'p2')).resolves.toBeNull();
    await expect(store.resolve('A'.repeat(43), 'u1', 'p1')).resolves.toBeNull();
  });

  it('is null once Redis has expired the key', async () => {
    const { store, data } = setup();
    const token = await store.issue('u1', 'p1', RECIPIENT);
    data.delete(recipientTokenKey(token));
    await expect(store.resolve(token, 'u1', 'p1')).resolves.toBeNull();
  });

  it('is null for malformed JSON, a wrong shape, and extra keys', async () => {
    const { store, data } = setup();
    const token = 'B'.repeat(43);
    const key = recipientTokenKey(token);
    const valid = {
      userId: 'u1',
      productId: 'p1',
      recipient: RECIPIENT,
      issuedAt: NOW.toISOString(),
    };
    for (const stored of [
      '{not json',
      'null',
      '"text"',
      JSON.stringify({ userId: 'u1' }),
      JSON.stringify({ ...valid, recipient: { username: 'x', displayName: 'Aziz' } }),
      JSON.stringify({ ...valid, extra: true }),
    ]) {
      data.set(key, stored);
      await expect(store.resolve(token, 'u1', 'p1')).resolves.toBeNull();
    }
  });

  it('fails closed when Redis is down: the error propagates, no record is returned', async () => {
    const { store, client } = setup();
    client.get.mockRejectedValueOnce(new Error('connection refused'));
    await expect(store.resolve('C'.repeat(43), 'u1', 'p1')).rejects.toThrow('connection refused');
  });
});

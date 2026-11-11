import { nextTestTelegramId } from './test-telegram-id';

describe('nextTestTelegramId (e2e users on the shared test DB)', () => {
  it('a burst in the same millisecond gives distinct, increasing, safe ids of this worker slot', () => {
    const ids = Array.from({ length: 5_000 }, () => nextTestTelegramId());
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i += 1) expect(ids[i]).toBeGreaterThan(ids[i - 1] ?? 0);
    const slots = new Set(ids.map((id) => id % 64));
    expect(slots.size).toBe(1);
    expect(ids.every((id) => Number.isSafeInteger(id) && id > Date.now())).toBe(true);
  });
});

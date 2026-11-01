import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_HTTP_STATUS, errorCodeSchema, errorMessageKey } from './errors';
import { QUEUES } from './queues';

describe('error codes', () => {
  it('maps every code to a 4xx/5xx status and has no duplicates', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(Object.keys(ERROR_HTTP_STATUS).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(ERROR_HTTP_STATUS[code]).toBeLessThan(600);
    }
  });

  it('matches the statuses in the API contract table (incl. D-24)', () => {
    expect(ERROR_HTTP_STATUS.INSUFFICIENT_BALANCE).toBe(422);
    expect(ERROR_HTTP_STATUS.QUOTE_EXPIRED).toBe(410);
    expect(ERROR_HTTP_STATUS.IDEMPOTENCY_CONFLICT).toBe(409);
    expect(ERROR_HTTP_STATUS.RATE_LIMITED).toBe(429);
    expect(ERROR_HTTP_STATUS.INTERNAL_ERROR).toBe(500);
    expect(ERROR_HTTP_STATUS.PAYLOAD_TOO_LARGE).toBe(413);
  });

  it('validates codes with the Zod enum and builds the i18n message key', () => {
    expect(errorCodeSchema.safeParse('NOT_FOUND').success).toBe(true);
    expect(errorCodeSchema.safeParse('NOPE').success).toBe(false);
    expect(errorMessageKey('INSUFFICIENT_BALANCE')).toBe('errors.INSUFFICIENT_BALANCE');
  });
});

describe('queue names', () => {
  it('are unique kebab-case names', () => {
    const names = Object.values(QUEUES);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });
});

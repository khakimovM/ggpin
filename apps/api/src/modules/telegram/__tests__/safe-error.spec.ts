import { HttpError } from 'grammy';
import { TEST_BOT_TOKEN } from '../../../config/__tests__/test-env';
import { safeErrorText } from '../safe-error';

describe('safeErrorText', () => {
  it('scrubs a bot token quoted in a grammY HttpError message', () => {
    const url = `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`;
    const error = new HttpError(
      `Network request for 'sendMessage' failed! request to ${url} failed`,
      new Error(`request to ${url} failed, reason: connect ETIMEDOUT`),
    );
    const text = safeErrorText(error);
    expect(text).toContain('HttpError');
    expect(text).toContain('sendMessage');
    expect(text).not.toContain(TEST_BOT_TOKEN);
    expect(text).not.toContain('a'.repeat(32));
  });

  // Review M1: a handler's failed database call, even wrapped, logs names only, never its data.
  it('a wrapped Prisma validation error: no value of the failed call reaches the text', () => {
    class PrismaClientValidationError extends Error {
      override name = 'PrismaClientValidationError';
    }
    const rendered = [
      'Invalid `tx.user.update()` invocation in',
      '  data: { username: "needle_user", phone: "998901234567" }',
    ].join('\n');
    const prisma = new PrismaClientValidationError(rendered);
    const text = safeErrorText(new Error(`handler failed: ${rendered}`, { cause: prisma }));
    expect(text).toBe(
      'Error caused by PrismaClientValidationError: Invalid `tx.user.update()` invocation in',
    );
    expect(text).not.toMatch(/needle_user|998901234567/);
  });

  it('is bounded to 300 characters', () => {
    expect(safeErrorText(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(300);
  });

  it('reports a thrown non-Error without echoing it', () => {
    expect(safeErrorText(`secret ${TEST_BOT_TOKEN}`)).toBe('non-Error thrown');
    expect(safeErrorText(undefined)).toBe('non-Error thrown');
  });
});

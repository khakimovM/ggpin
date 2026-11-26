import { BotError, HttpError, type Context } from 'grammy';
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

  // S2 review nit 2: grammY keeps the handler's error in BotError.error (not `cause`) and repeats
  // its message in its own; the inner error must be what is described.
  it('a BotError wrapping a database error: names only, no value from either message', () => {
    class PrismaClientValidationError extends Error {
      override name = 'PrismaClientValidationError';
    }
    const rendered = 'Invalid `tx.user.update()` invocation in\n  data: { phone: "998901234567" }';
    const botError = new BotError(new PrismaClientValidationError(rendered), {} as Context);
    expect(botError.message).toContain('998901234567'); // grammY repeats it: the reason for this
    const text = safeErrorText(botError);
    expect(text).toBe(
      'BotError caused by PrismaClientValidationError: Invalid `tx.user.update()` invocation in',
    );
    expect(text).not.toContain('998901234567');
  });

  it('a BotError wrapping an HttpError: the token is scrubbed', () => {
    const url = `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`;
    const inner = new HttpError(`request to ${url} failed`, new Error('ETIMEDOUT'));
    const text = safeErrorText(new BotError(inner, {} as Context));
    expect(text.startsWith('BotError caused by HttpError')).toBe(true);
    expect(text).not.toContain(TEST_BOT_TOKEN);
  });

  it('a BotError around a non-Error value does not echo it', () => {
    const text = safeErrorText(new BotError(`secret ${TEST_BOT_TOKEN}`, {} as Context));
    expect(text).toBe('BotError caused by non-Error thrown');
  });

  it('is bounded to 300 characters', () => {
    expect(safeErrorText(new BotError(new Error('x'.repeat(5000)), {} as Context)).length).toBe(
      300,
    );
    expect(safeErrorText(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(300);
  });

  it('reports a thrown non-Error without echoing it', () => {
    expect(safeErrorText(`secret ${TEST_BOT_TOKEN}`)).toBe('non-Error thrown');
    expect(safeErrorText(undefined)).toBe('non-Error thrown');
  });
});

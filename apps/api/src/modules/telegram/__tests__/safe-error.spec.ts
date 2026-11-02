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

  it('is bounded to 300 characters', () => {
    expect(safeErrorText(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(300);
  });

  it('reports a thrown non-Error without echoing it', () => {
    expect(safeErrorText(`secret ${TEST_BOT_TOKEN}`)).toBe('non-Error thrown');
    expect(safeErrorText(undefined)).toBe('non-Error thrown');
  });
});

import type { ValidateRecipientResponse } from '@repo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiErrorCode } from '../../../lib/api/errors';
import { useValidateRecipient } from '../use-validate-recipient';

const validateRecipient = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api/recipients', () => ({ validateRecipient }));

const TOKEN = 'R'.repeat(43);
const onProductChanged = vi.fn();
const FOUND: ValidateRecipientResponse = {
  recipientToken: TOKEN,
  displayName: 'Aziz',
  warnings: [],
};

function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useValidateRecipient('p_stars', 'username', onProductChanged), {
    wrapper,
  });
}

beforeEach(() => {
  validateRecipient.mockReset();
  onProductChanged.mockReset();
});

describe('checking a recipient', () => {
  it('a malformed username is invalid and never leaves the browser', () => {
    const { result } = setup();
    act(() => result.current.setUsername('dk'));
    act(() => result.current.check());
    expect(result.current.state.phase).toBe('invalid');
    expect(validateRecipient).not.toHaveBeenCalled();
  });

  it('sends the product id and the field under the inputSchema key, without the @', async () => {
    validateRecipient.mockResolvedValue(FOUND);
    const { result } = setup();
    act(() => result.current.setUsername('@aziz_k'));
    act(() => result.current.check());
    expect(result.current.state.phase).toBe('checking');
    await waitFor(() => expect(result.current.state.phase).toBe('found'));
    expect(validateRecipient.mock.calls[0]?.[0]).toEqual({
      productId: 'p_stars',
      input: { username: 'aziz_k' },
    });
  });

  it('the token is available only after the visitor confirmed', async () => {
    validateRecipient.mockResolvedValue(FOUND);
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(result.current.state.phase).toBe('found'));
    expect(result.current.confirmedToken).toBeNull();
    act(() => result.current.confirm());
    expect(result.current.confirmedToken).toBe(TOKEN);
  });

  const failures: Array<[ApiErrorCode, number, string]> = [
    ['RECIPIENT_NOT_FOUND', 422, 'notfound'],
    ['RECIPIENT_INVALID', 422, 'invalid'],
    ['RECIPIENT_HAS_PREMIUM', 422, 'blocked'],
    ['RECIPIENT_CHECK_UNAVAILABLE', 503, 'down'],
    ['NETWORK', 0, 'down'],
  ];
  it.each(failures)('%s -> %s', async (code, status, phase) => {
    validateRecipient.mockRejectedValue(new ApiError({ status, code }));
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(result.current.state.phase).toBe(phase));
    expect(result.current.confirmedToken).toBeNull();
  });

  it('an edit while checking cancels the check, and its late answer confirms nobody', async () => {
    let signal: AbortSignal | undefined;
    let answer: (value: ValidateRecipientResponse) => void = () => undefined;
    validateRecipient.mockImplementation(
      (_body: unknown, requestSignal: AbortSignal) =>
        new Promise<ValidateRecipientResponse>((resolve) => {
          signal = requestSignal;
          answer = resolve;
        }),
    );
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(signal).toBeDefined());
    act(() => result.current.setUsername('someone_else'));
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      answer(FOUND);
      await Promise.resolve();
    });
    expect(result.current.state).toMatchObject({ phase: 'idle', username: 'someone_else' });
    expect(result.current.confirmedToken).toBeNull();
  });

  it('"change" after a confirmation takes the token away again', async () => {
    validateRecipient.mockResolvedValue(FOUND);
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(result.current.state.phase).toBe('found'));
    act(() => result.current.confirm());
    act(() => result.current.reset());
    expect(result.current.confirmedToken).toBeNull();
    expect(result.current.state).toMatchObject({ phase: 'idle', username: 'aziz_k' });
  });

  it('the same text again (with an @ or spaces) is not an edit: the check on its way stays', async () => {
    let signal: AbortSignal | undefined;
    validateRecipient.mockImplementation(
      (_body: unknown, requestSignal: AbortSignal) =>
        new Promise<ValidateRecipientResponse>(() => {
          signal = requestSignal;
        }),
    );
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(signal).toBeDefined());
    act(() => result.current.setUsername('  @aziz_k '));
    expect(signal?.aborted).toBe(false);
    expect(result.current.state.phase).toBe('checking');
  });

  it('PRODUCT_UNAVAILABLE reloads the product, and the visitor can retry', async () => {
    validateRecipient.mockRejectedValue(new ApiError({ status: 422, code: 'PRODUCT_UNAVAILABLE' }));
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(result.current.state.phase).toBe('down'));
    expect(onProductChanged).toHaveBeenCalledTimes(1);
  });

  it('429: no new check until Retry-After has passed', async () => {
    validateRecipient.mockRejectedValue(
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 30 }),
    );
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(result.current.state.phase).toBe('down'));
    const retryAt = result.current.state.retryAt;
    expect(retryAt).toBeGreaterThan(Date.now() + 25_000);

    act(() => result.current.check());
    expect(validateRecipient).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe('down');
  });

  it('expire() after a confirmation asks for the recipient again, keeping the username', async () => {
    validateRecipient.mockResolvedValue(FOUND);
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(result.current.state.phase).toBe('found'));
    act(() => result.current.confirm());
    expect(result.current.confirmedToken).toBe(TOKEN);
    act(() => result.current.expire());
    expect(result.current.confirmedToken).toBeNull();
    expect(result.current.state).toMatchObject({
      phase: 'expired',
      username: 'aziz_k',
      token: null,
    });
  });
});

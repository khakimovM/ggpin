import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { RECIPIENT_REQUEST_TIMEOUT_MS } from '../use-validate-recipient';
import { answerFor, heldApi as heldApiOf, setupHook as setup } from './recipient-hook-kit';

// A request that hangs on the network must not hold the form (or the check queued behind it)
// forever: after RECIPIENT_REQUEST_TIMEOUT_MS it is given up as NETWORK -> `down`.

const validateRecipient = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api/recipients', () => ({ validateRecipient }));
const heldApi = () => heldApiOf(validateRecipient);

beforeEach(() => {
  validateRecipient.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('a hanging recipient request', () => {
  it('waits the whole timeout, then says "could not check" and can be retried', async () => {
    const api = heldApi();
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(api.pending).toHaveLength(1));

    await advance(RECIPIENT_REQUEST_TIMEOUT_MS - 1_000);
    expect(result.current.state.phase).toBe('checking');
    expect(api.pending[0]?.signal.aborted).toBe(false);

    await advance(1_000);
    await waitFor(() => expect(result.current.state.phase).toBe('down'));
    expect(api.pending[0]?.signal.aborted).toBe(true);
    expect(result.current.state.retryAt).toBeNull();

    act(() => result.current.check());
    await waitFor(() => expect(api.pending).toHaveLength(2));
  });

  it('a hanging A gives up at the timeout, and the queued B then goes and lands', async () => {
    const api = heldApi();
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(api.pending).toHaveLength(1));
    act(() => result.current.setUsername('sardor_r'));
    act(() => result.current.check());

    await advance(RECIPIENT_REQUEST_TIMEOUT_MS + 100);
    await waitFor(() => expect(api.pending).toHaveLength(2));
    expect(api.pending[1]?.username).toBe('sardor_r');
    // A's timeout is about someone no longer in the field: B's check is still the one shown.
    expect(result.current.state.phase).toBe('checking');
    await act(async () => {
      api.pending[1]?.resolve(answerFor('sardor_r'));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('found'));
    expect(api.maxOpen()).toBe(1);
  });

  it('an answer in time clears the timer: nothing fires later', async () => {
    const api = heldApi();
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(api.pending).toHaveLength(1));
    await act(async () => {
      api.pending[0]?.resolve(answerFor('aziz_k'));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('found'));
    expect(vi.getTimerCount()).toBe(0);
    await advance(RECIPIENT_REQUEST_TIMEOUT_MS * 2);
    expect(result.current.state.phase).toBe('found');
    expect(api.pending[0]?.signal.aborted).toBe(false);
  });
});

describe('the request promise never rejects', () => {
  it('a throwing onProductChanged leaves no rejected promise and no stuck form', async () => {
    validateRecipient.mockRejectedValueOnce(
      new ApiError({ status: 422, code: 'PRODUCT_UNAVAILABLE' }),
    );
    const onProductChanged = vi.fn(() => {
      throw new Error('reload failed');
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { result } = setup(onProductChanged);
      act(() => result.current.setUsername('aziz_k'));
      act(() => result.current.check());
      await waitFor(() => expect(result.current.state.phase).toBe('down'));
      expect(onProductChanged).toHaveBeenCalledTimes(1);

      validateRecipient.mockResolvedValueOnce(answerFor('aziz_k'));
      act(() => result.current.check());
      await waitFor(() => expect(result.current.state.phase).toBe('found'));
      await advance(10);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

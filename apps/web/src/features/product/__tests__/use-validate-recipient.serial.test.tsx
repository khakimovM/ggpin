import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { answerFor, heldApi as heldApiOf, setupHook as setup } from './recipient-hook-kit';

// N8: one form never has two `/recipients/validate` requests on their way at once (the server
// holds a per-user slot until its handler is done; a second one meets a 429), and CR #7: the
// canonical username is the one that is sent and compared.

const validateRecipient = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api/recipients', () => ({ validateRecipient }));
const heldApi = () => heldApiOf(validateRecipient);

beforeEach(() => {
  validateRecipient.mockReset();
});

describe('one check on its way at a time', () => {
  it('edit + check at once: the second request waits for the first; the first answer is ignored', async () => {
    const api = heldApi();
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(api.pending).toHaveLength(1));

    act(() => result.current.setUsername('sardor_r'));
    act(() => result.current.check());
    // Shown as checking, but nothing new left the browser while the first is open.
    expect(result.current.state.phase).toBe('checking');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(validateRecipient).toHaveBeenCalledTimes(1);

    await act(async () => {
      api.pending[0]?.resolve(answerFor('aziz_k'));
      await Promise.resolve();
    });
    await waitFor(() => expect(api.pending).toHaveLength(2));
    expect(api.pending[1]?.username).toBe('sardor_r');
    // The late answer about aziz_k did not land on sardor_r.
    expect(result.current.state).toMatchObject({ phase: 'checking', found: null, token: null });

    await act(async () => {
      api.pending[1]?.resolve(answerFor('sardor_r'));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('found'));
    expect(result.current.state.found?.displayName).toBe('sardor_r');
    expect(api.maxOpen()).toBe(1);
    expect(api.pending[0]?.signal.aborted).toBe(false);
  });

  it('several edits and checks while one is open still send only the newest, once', async () => {
    const api = heldApi();
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(api.pending).toHaveLength(1));
    for (const name of ['first_one', 'second_one', 'third_one']) {
      act(() => result.current.setUsername(name));
      act(() => result.current.check());
    }
    await act(async () => {
      api.pending[0]?.resolve(answerFor('aziz_k'));
      await Promise.resolve();
    });
    await waitFor(() => expect(api.pending).toHaveLength(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(api.pending.map((p) => p.username)).toEqual(['aziz_k', 'third_one']);
    expect(api.maxOpen()).toBe(1);
  });

  it('an edit back to idle sends nothing when the first request ends', async () => {
    const api = heldApi();
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(api.pending).toHaveLength(1));
    act(() => result.current.setUsername('sardor_r'));
    act(() => result.current.check());
    act(() => result.current.setUsername('sardor_rr'));
    await act(async () => {
      api.pending[0]?.resolve(answerFor('aziz_k'));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(validateRecipient).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({ phase: 'idle', username: 'sardor_rr' });
  });

  it('the ignored request failing (not found, 429) shows nothing; the queued one goes and lands', async () => {
    for (const error of [
      new ApiError({ status: 422, code: 'RECIPIENT_NOT_FOUND' }),
      new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 30 }),
    ]) {
      validateRecipient.mockReset();
      const api = heldApi();
      const { result, unmount } = setup();
      act(() => result.current.setUsername('aziz_k'));
      act(() => result.current.check());
      await waitFor(() => expect(api.pending).toHaveLength(1));
      act(() => result.current.setUsername('sardor_r'));
      act(() => result.current.check());

      await act(async () => {
        api.pending[0]?.reject(error);
        await Promise.resolve();
      });
      // A's error is about someone no longer in the field: still checking, no wait, no message.
      expect(result.current.state).toMatchObject({ phase: 'checking', retryAt: null });
      await waitFor(() => expect(api.pending).toHaveLength(2));
      expect(api.pending[1]?.username).toBe('sardor_r');
      await act(async () => {
        api.pending[1]?.resolve(answerFor('sardor_r'));
        await Promise.resolve();
      });
      await waitFor(() => expect(result.current.state.phase).toBe('found'));
      expect(result.current.state.found?.displayName).toBe('sardor_r');
      expect(api.maxOpen()).toBe(1);
      unmount();
    }
  });

  it('away and back to the same name: the old request is still ignored (the reducer cannot tell)', async () => {
    // aziz_k -> sardor_r -> aziz_k: the old answer names the person in the field again, so only the
    // hook's generation guard keeps it from being taken as the answer to the new check.
    const api = heldApi();
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(api.pending).toHaveLength(1));
    act(() => result.current.setUsername('sardor_r'));
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());

    await act(async () => {
      api.pending[0]?.reject(new ApiError({ status: 422, code: 'RECIPIENT_NOT_FOUND' }));
      await Promise.resolve();
    });
    expect(result.current.state.phase).toBe('checking');
    await waitFor(() => expect(api.pending).toHaveLength(2));
    await act(async () => {
      api.pending[1]?.resolve(answerFor('aziz_k'));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('found'));
    expect(api.maxOpen()).toBe(1);
  });

  it('away and back: an old SUCCESS is ignored too; only the new request confirms', async () => {
    const api = heldApi();
    const { result } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(api.pending).toHaveLength(1));
    act(() => result.current.setUsername('sardor_r'));
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await act(async () => {
      api.pending[0]?.resolve(answerFor('old_answer'));
      await Promise.resolve();
    });
    expect(result.current.state).toMatchObject({ phase: 'checking', token: null });
    await waitFor(() => expect(api.pending).toHaveLength(2));
  });

  it('unmounting aborts the request on its way', async () => {
    const api = heldApi();
    const { result, unmount } = setup();
    act(() => result.current.setUsername('aziz_k'));
    act(() => result.current.check());
    await waitFor(() => expect(api.pending).toHaveLength(1));
    unmount();
    expect(api.pending[0]?.signal.aborted).toBe(true);
  });
});

describe('the canonical username', () => {
  it('Aziz_K -> aziz_k after a confirmation keeps it: same person, same token, no request', async () => {
    validateRecipient.mockResolvedValue(answerFor('Aziz'));
    const { result } = setup();
    act(() => result.current.setUsername('Aziz_K'));
    act(() => result.current.check());
    await waitFor(() => expect(result.current.state.phase).toBe('found'));
    act(() => result.current.confirm());
    const token = result.current.confirmedToken;
    expect(token).not.toBeNull();

    act(() => result.current.setUsername('aziz_k'));
    expect(result.current.confirmedToken).toBe(token);
    expect(result.current.state).toMatchObject({ phase: 'confirmed', username: 'aziz_k' });
    expect(result.current.canonical).toBe('aziz_k');
    expect(validateRecipient).toHaveBeenCalledTimes(1);
  });

  it('Aziz_K -> aziz_k while checking keeps the check and lets its answer land', async () => {
    const api = heldApi();
    const { result } = setup();
    act(() => result.current.setUsername('Aziz_K'));
    act(() => result.current.check());
    await waitFor(() => expect(api.pending).toHaveLength(1));
    act(() => result.current.setUsername('aziz_k'));
    await act(async () => {
      api.pending[0]?.resolve(answerFor('Aziz'));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('found'));
    expect(api.pending[0]?.username).toBe('aziz_k');
  });
});

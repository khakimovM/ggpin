import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeAuthEvents } from '../../../lib/api/auth-broadcast';
import { AuthSync } from '../AuthSync';

// The factory of a mocked module runs when it is first imported: counting it shows when
// auth-remote (the API client and the query client behind it) is loaded. The test never imports
// it statically, or the count would start at 1.
const remoteLoads = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/api/auth-broadcast', () => ({ subscribeAuthEvents: vi.fn() }));
vi.mock('../../../lib/api/auth-remote', () => {
  remoteLoads();
  return { applyRemoteAuthEvent: vi.fn() };
});

afterEach(() => vi.clearAllMocks());

describe('AuthSync', () => {
  it('subscribes on mount and unsubscribes on unmount, rendering nothing', () => {
    const unsubscribe = vi.fn();
    vi.mocked(subscribeAuthEvents).mockReturnValue(unsubscribe);

    const { unmount, container } = render(<AuthSync />);
    expect(container).toBeEmptyDOMElement();
    expect(subscribeAuthEvents).toHaveBeenCalledTimes(1);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('loads the client only when another tab sends an event, then hands it the event', async () => {
    vi.mocked(subscribeAuthEvents).mockReturnValue(() => undefined);
    render(<AuthSync />);

    // Mounted, no event yet: the API client has not been loaded.
    expect(remoteLoads).not.toHaveBeenCalled();

    const handler = vi.mocked(subscribeAuthEvents).mock.calls[0]?.[0];
    handler?.('signed-out');

    await waitFor(() => expect(remoteLoads).toHaveBeenCalledTimes(1));
    const { applyRemoteAuthEvent } = await import('../../../lib/api/auth-remote');
    await waitFor(() => expect(applyRemoteAuthEvent).toHaveBeenCalledExactlyOnceWith('signed-out'));

    handler?.('signed-in');
    await waitFor(() => expect(applyRemoteAuthEvent).toHaveBeenLastCalledWith('signed-in'));
    expect(applyRemoteAuthEvent).toHaveBeenCalledTimes(2);
  });
});

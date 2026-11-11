import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeAuthEvents } from '../../../lib/api/auth-broadcast';
import { applyRemoteAuthEvent } from '../../../lib/api/auth-remote';
import { AuthSync } from '../AuthSync';

vi.mock('../../../lib/api/auth-broadcast', () => ({ subscribeAuthEvents: vi.fn() }));
vi.mock('../../../lib/api/auth-remote', () => ({ applyRemoteAuthEvent: vi.fn() }));

afterEach(() => vi.clearAllMocks());

describe('AuthSync', () => {
  it('subscribes on mount, hands events to the client, and unsubscribes on unmount', () => {
    const unsubscribe = vi.fn();
    vi.mocked(subscribeAuthEvents).mockReturnValue(unsubscribe);

    const { unmount, container } = render(<AuthSync />);
    expect(container).toBeEmptyDOMElement();
    expect(subscribeAuthEvents).toHaveBeenCalledTimes(1);

    const handler = vi.mocked(subscribeAuthEvents).mock.calls[0]?.[0];
    handler?.('signed-out');
    expect(applyRemoteAuthEvent).toHaveBeenCalledExactlyOnceWith('signed-out');

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

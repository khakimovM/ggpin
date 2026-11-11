import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A BroadcastChannel with the real semantics: a message reaches every OTHER open channel object
// of the same name (also in the same page), never the object that posted it.
class FakeChannel {
  static open = new Set<FakeChannel>();
  static created: string[] = [];
  private listeners = new Set<(message: MessageEvent<unknown>) => void>();
  constructor(readonly name: string) {
    FakeChannel.open.add(this);
    FakeChannel.created.push(name);
  }
  addEventListener(_type: 'message', listener: (message: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'message', listener: (message: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener);
  }
  postMessage(data: unknown): void {
    for (const other of FakeChannel.open) {
      if (other === this || other.name !== this.name) continue;
      for (const listener of other.listeners) listener(new MessageEvent('message', { data }));
    }
  }
  close(): void {
    FakeChannel.open.delete(this);
  }
}

// The module keeps one channel per page, so every test loads a fresh copy.
async function load() {
  return import('../auth-broadcast');
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  FakeChannel.open.clear();
  FakeChannel.created = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('BroadcastChannel transport', () => {
  it('delivers an event posted by another tab, as a bare event name', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    const { AUTH_CHANNEL_NAME, subscribeAuthEvents } = await load();
    const received = vi.fn();
    const unsubscribe = subscribeAuthEvents(received);

    new FakeChannel(AUTH_CHANNEL_NAME).postMessage({ type: 'signed-out' });

    expect(received).toHaveBeenCalledExactlyOnceWith('signed-out');
    unsubscribe();
  });

  it('a tab is never told about its own sign-in or sign-out', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    const { AUTH_CHANNEL_NAME, broadcastAuthEvent, subscribeAuthEvents } = await load();
    const own = vi.fn();
    subscribeAuthEvents(own);
    const otherTab = vi.fn();
    const peer = new FakeChannel(AUTH_CHANNEL_NAME);
    peer.addEventListener('message', (message) => {
      otherTab(message.data);
    });

    broadcastAuthEvent('signed-in');
    broadcastAuthEvent('signed-out');

    expect(own).not.toHaveBeenCalled();
    expect(otherTab.mock.calls).toEqual([[{ type: 'signed-in' }], [{ type: 'signed-out' }]]);
    // One channel object serves both directions; a second one would hear the tab's own posts.
    expect(FakeChannel.created.filter((name) => name === AUTH_CHANNEL_NAME)).toHaveLength(2);
  });

  it('the channel is named ggpin-auth', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    const { AUTH_CHANNEL_NAME, broadcastAuthEvent } = await load();
    broadcastAuthEvent('signed-out');
    expect(AUTH_CHANNEL_NAME).toBe('ggpin-auth');
    expect(FakeChannel.created).toEqual(['ggpin-auth']);
  });

  it('ignores messages that are not an auth event', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    const { AUTH_CHANNEL_NAME, subscribeAuthEvents } = await load();
    const received = vi.fn();
    subscribeAuthEvents(received);
    const stranger = new FakeChannel(AUTH_CHANNEL_NAME);
    for (const data of [null, 'signed-out', { type: 'logout-everything' }, { type: 42 }, {}]) {
      stranger.postMessage(data);
    }
    expect(received).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    const { AUTH_CHANNEL_NAME, subscribeAuthEvents } = await load();
    const received = vi.fn();
    subscribeAuthEvents(received)();
    new FakeChannel(AUTH_CHANNEL_NAME).postMessage({ type: 'signed-out' });
    expect(received).not.toHaveBeenCalled();
  });
});

describe('storage fallback (no BroadcastChannel)', () => {
  const storageEvent = (newValue: string | null, key: string) =>
    window.dispatchEvent(new StorageEvent('storage', { key, newValue }));

  it('writes the event and removes it at once, so nothing stays in storage', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const { AUTH_STORAGE_KEY, broadcastAuthEvent } = await load();
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const remove = vi.spyOn(Storage.prototype, 'removeItem');

    broadcastAuthEvent('signed-out');

    expect(set).toHaveBeenCalledWith(AUTH_STORAGE_KEY, expect.stringContaining('"signed-out"'));
    expect(remove).toHaveBeenCalledWith(AUTH_STORAGE_KEY);
    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('a storage event from another tab is delivered; foreign keys and garbage are not', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const { AUTH_STORAGE_KEY, subscribeAuthEvents } = await load();
    const received = vi.fn();
    const unsubscribe = subscribeAuthEvents(received);

    storageEvent(JSON.stringify({ type: 'signed-in', at: 1 }), AUTH_STORAGE_KEY);
    expect(received).toHaveBeenCalledExactlyOnceWith('signed-in');

    storageEvent(JSON.stringify({ type: 'signed-out' }), 'some-other-key');
    storageEvent('not json', AUTH_STORAGE_KEY);
    storageEvent(JSON.stringify({ type: 'nope' }), AUTH_STORAGE_KEY);
    storageEvent(null, AUTH_STORAGE_KEY); // the removal that follows every write
    expect(received).toHaveBeenCalledTimes(1);

    unsubscribe();
    storageEvent(JSON.stringify({ type: 'signed-out' }), AUTH_STORAGE_KEY);
    expect(received).toHaveBeenCalledTimes(1);
  });

  it('broadcasting survives blocked storage', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const { broadcastAuthEvent } = await load();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(() => broadcastAuthEvent('signed-out')).not.toThrow();
  });
});

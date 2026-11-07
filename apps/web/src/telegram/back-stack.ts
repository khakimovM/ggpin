// What the Telegram BackButton does first. An open sheet or modal registers a handler here and
// the BackButton closes it instead of leaving the screen; with no handler it navigates back.
// Module-level on purpose: the BackButton is one physical control for the whole Mini App.
type BackHandler = () => void;

const handlers: BackHandler[] = [];
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

/** Registers a handler on top of the stack; the returned function removes it. */
export function pushBackHandler(handler: BackHandler): () => void {
  handlers.push(handler);
  notify();
  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
    notify();
  };
}

/** Runs the topmost handler. Returns false when there is none (the caller navigates back). */
export function runBackHandler(): boolean {
  const top = handlers.at(-1);
  if (!top) return false;
  top();
  return true;
}

export const hasBackHandler = (): boolean => handlers.length > 0;

/** For useSyncExternalStore: tells when a handler comes or goes. */
export function subscribeBackStack(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

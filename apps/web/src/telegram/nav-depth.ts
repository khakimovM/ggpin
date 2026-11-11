// How many history entries the Mini App itself has pushed and not yet gone back over. The
// BackButton needs this, not `history.length`: after a deep link /tg/a -> push /tg/b -> back to
// /tg/a the length is 2, yet there is nothing left to go back to inside the app, and `router.back()`
// would do nothing (a dead button). Deep-link entry is 0, a push is +1, a back is -1.
//
// Counted at the source: `history.pushState` (what every client-side navigation ends in) and the
// `popstate` event. `replaceState` does not add an entry, so it does not count. The Mini App has no
// forward control, so every popstate is a back.
let depth = 0;
let installs = 0;
let restore: (() => void) | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

export const getNavDepth = (): number => depth;

export function subscribeNavDepth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Starts counting (reference-counted: every caller must call the returned function). */
export function installNavDepth(): () => void {
  installs += 1;
  if (installs === 1) {
    const original: History['pushState'] = Reflect.get(history, 'pushState');
    let active = true;
    const counting: typeof history.pushState = function (this: History, ...args) {
      original.apply(history, args);
      if (active) {
        depth += 1;
        notify();
      }
    };
    const onPop = () => {
      depth = Math.max(0, depth - 1);
      notify();
    };
    history.pushState = counting;
    window.addEventListener('popstate', onPop);
    restore = () => {
      active = false;
      window.removeEventListener('popstate', onPop);
      // Only unhook if nobody wrapped us since; otherwise stay in the chain, switched off.
      if (history.pushState === counting) history.pushState = original;
      depth = 0;
    };
  }
  return () => {
    installs -= 1;
    if (installs === 0) {
      restore?.();
      restore = null;
    }
  };
}

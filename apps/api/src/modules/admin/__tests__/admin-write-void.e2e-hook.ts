// 9-B SA-1 race tests: a provider method replaced for one test, to force an interleaving on
// real Postgres locks (admin-write-void-races / -credit e2e specs).

/** Replaces `obj[name]` until `restore()`; the replacement gets the original (bound). */
export function hook<T extends object, K extends keyof T>(
  obj: T,
  name: K,
  make: (original: T[K]) => T[K],
): { restore: () => void } {
  const original = obj[name];
  const bound = (typeof original === 'function' ? original.bind(obj) : original) as T[K];
  obj[name] = make(bound);
  return {
    restore: () => {
      obj[name] = original;
    },
  };
}

import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** History state of an entry this hook pushed: the drawer it opened. */
interface DrawerState {
  drawerOpened: string;
}

function openedHere(state: unknown, name: string): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as Partial<DrawerState>).drawerOpened === name
  );
}

/**
 * A detail drawer kept in the URL (`?review=<id>`): a reload or a shared link opens the same
 * drawer, Back closes it. Anything that is not an id shape is ignored.
 *
 * Closing never adds a history entry (R-5): a drawer opened inside the app pushed one entry, so
 * closing steps back over it (Back then leaves the list, it does not reopen the drawer); a drawer
 * that arrived with the URL (reload, shared link) replaces its entry with the list.
 */
export function useDrawerParam(name: string) {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const raw = search.get(name);
  const id = raw !== null && ID.test(raw) ? raw : null;
  const pushed = openedHere(location.state, name);
  const open = useCallback(
    (value: string) => {
      const state: DrawerState = { drawerOpened: name };
      setSearch(
        (current) => {
          const next = new URLSearchParams(current);
          next.set(name, value);
          return next;
        },
        // Switching rows inside an open drawer replaces its entry: one Back still closes it.
        { state, replace: pushed },
      );
    },
    [name, pushed, setSearch],
  );
  const close = useCallback(() => {
    if (pushed) {
      void navigate(-1);
      return;
    }
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(name);
        return next;
      },
      { replace: true },
    );
  }, [name, navigate, pushed, setSearch]);
  return { id, open, close };
}

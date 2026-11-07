'use client';

import { useLocale } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { stripLocale } from '../../i18n/locale-path';
import { localizedPath } from '../../i18n/paths';
import { sanitizeSearch } from '../catalog/catalog-query';
import { useCatalogSearch } from '../catalog/use-catalog-search';
import { useCatalogSearchStore } from '../../stores/catalog-search-store';

const CATALOG_PATH = '/store';

/**
 * THE RULE (check every change against it):
 *  - entering the catalog, or the address changing on it: the box is taken FROM the address;
 *  - writing: only when the search itself changed, and only as a real navigation. Never because
 *    the page changed, never when the address already says it.
 *
 * Keeps the catalog search in the web URL (`/store?q=...`), so a search can be shared and survives
 * a reload. Mounted once, in the store header. The URL is written only when the SEARCH changes,
 * never because the page did: going from `/store?q=pubg` to the profile must not push the
 * catalog back (the visitor could not leave, and "back" would loop). The search box keeps its text
 * across pages; the catalog address it came from is not restored.
 *  - on load, a `?q=` in the URL fills the search box;
 *  - afterwards the debounced search is written to the URL (replace, so the back button does not
 *    step through every search); searching from another page of the store (the profile) goes to
 *    the catalog, because that is where the results are.
 */
export function useSearchUrlSync(): void {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  const { text, query, setText } = useCatalogSearch();
  // True from a keystroke until the debounced query has caught up with the box.
  const pending = sanitizeSearch(text) !== query;

  // The latest URL parameters, read by the sync below without making every URL change a trigger.
  const latest = useRef(params);
  useEffect(() => {
    latest.current = params;
  });

  // The search last written to (or read from) the address, and the values written since the
  // address last agreed with it (their navigations may still be on the way).
  const written = useRef('');
  const inFlight = useRef(new Set<string>());
  // The `q` the address had when this hook last looked at it on the catalog (null: not yet).
  const seen = useRef<string | null>(null);

  // Address -> box, on the catalog page: at load, and whenever the address changes by itself (the
  // browser's back button, a link). `/store` -> profile -> a search typed there -> back twice must
  // end with an empty box on `/store`. Recording `written` before the box is filled matters: the
  // search settles 300 ms later, and a settled search that looked "new" would push the catalog
  // back over a visitor who has since gone to another page. On other pages the address has no
  // `q` by design, and the box keeps its text.
  useEffect(() => {
    if (stripLocale(pathname) !== CATALOG_PATH) {
      // Away from the catalog the box may change (cleared on the profile). Coming back must read the
      // address afresh, whatever it said the last time.
      seen.current = null;
      return;
    }
    const fromUrl = sanitizeSearch(params.get('q') ?? '');
    // Only a change of the address is news; a re-run for another reason is not.
    if (fromUrl === seen.current) return;
    seen.current = fromUrl;
    // "Matches what we wrote" only counts if the box agrees too, or the value is ours on its way
    // (the visitor typing on). A header mounted afresh over an old text has nothing in flight: the
    // box is then brought to the address, never the other way round.
    if (
      fromUrl === written.current &&
      (inFlight.current.has(fromUrl) ||
        sanitizeSearch(useCatalogSearchStore.getState().text) === fromUrl)
    ) {
      inFlight.current.clear();
      return;
    }
    // An older write of our own arriving late is not a change made from outside: the box stays,
    // and the address is put right again (it would otherwise keep a search the box no longer has).
    if (inFlight.current.has(fromUrl)) {
      const next = new URLSearchParams(params.toString());
      if (written.current === '') next.delete('q');
      else next.set('q', written.current);
      router.replace(`${pathname}${next.size > 0 ? `?${next.toString()}` : ''}`, { scroll: false });
      return;
    }
    // Taken from outside: nothing of ours is on its way any more.
    inFlight.current.clear();
    written.current = fromUrl;
    setText(fromUrl);
  }, [params, pathname, router, setText]);

  // The first run is skipped: the box is filled from the URL only after it, and the search still
  // reads empty. (Under StrictMode the effect runs twice and `first` is already false the second
  // time, so it does not really protect; the real guard is the live-text check below.) While the
  // search is catching up with the box (`pending`) nothing is written, so a
  // re-run for another reason (a navigation) cannot strip a `?q=` that is about to match.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // `pending` is the render's view. The box may have been changed since by the address -> box
    // sync above, in this same commit: the live text is the truth, and a query that does not match
    // it is about to be replaced, not something to write.
    if (pending || sanitizeSearch(useCatalogSearchStore.getState().text) !== query) return;
    // Only a changed search may navigate; a re-run because the pathname changed does not.
    if (query === written.current) return;
    written.current = query;
    const onCatalog = stripLocale(pathname) === CATALOG_PATH;
    const current = latest.current.get('q') ?? '';
    if (query === current) return;
    if (!onCatalog && query === '') return;
    // From here on a navigation really is made, so its value may arrive late (see above).
    inFlight.current.add(query);
    const next = new URLSearchParams(onCatalog ? latest.current.toString() : '');
    if (query === '') next.delete('q');
    else next.set('q', query);
    const suffix = next.size > 0 ? `?${next.toString()}` : '';
    if (onCatalog) router.replace(`${pathname}${suffix}`, { scroll: false });
    else router.push(`${localizedPath(locale, CATALOG_PATH)}${suffix}`, { scroll: false });
  }, [query, pending, pathname, locale, router]);
}

// jsdom has no matchMedia. Tests install a fake that answers by query text; the shared setup
// file removes it after every test.
export function mockMatchMedia(matches: (query: string) => boolean): void {
  window.matchMedia = (query: string) =>
    ({
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

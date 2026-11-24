// A stand-in for the Umami tracker in the browser (phase 8 S5). The real script is served by the
// Umami container (phase 11) and is not an npm package, so the tests run this one instead. It
// copies the parts of umami-software/umami v3.5.0 `src/tracker/index.ts` that decide what a beacon
// carries, with the same attribute names and the same order of steps:
//
// - config from the tag's data-* attributes (`config`);
// - `normalize`: `new URL(raw, location.href)`, then search and/or hash cleared by
//   data-exclude-search / data-exclude-hash; applied to `location.href` and `document.referrer`
//   at start and to every pushState/replaceState URL;
// - `stripOrigin` on the referrer (a same-site referrer is sent as a path);
// - data-do-not-track: nothing is sent when navigator.doNotTrack is "1";
// - `send`: window[data-before-send](type, payload) has the last word, a falsy result sends
//   nothing; then POST `<script dir>/api/send` with `{ type, payload }`, credentials omitted;
// - the first page view once the document is complete, later ones 300 ms after a history change
//   to a different URL; the history hook calls the browser's own method first, then reads the
//   change (as v3.5.0's `hook` does).
//
// It proves what OUR tag and filter make the tracker send. It does not prove the real tracker's
// code: phase 11 pins the Umami version (>= v3.0.0, see SiteAnalytics.tsx) and checks one real
// beacon on the VPS.
export const FAKE_UMAMI_TRACKER = String.raw`(() => {
  const script = document.currentScript;
  if (!script) return;
  const config = (name) => script.getAttribute('data-' + name);
  const website = config('website-id');
  const excludeSearch = config('exclude-search') === 'true';
  const excludeHash = config('exclude-hash') === 'true';
  const dnt = config('do-not-track') === 'true';
  const endpoint = script.src.split('/').slice(0, -1).join('/') + '/api/send';
  const { origin } = location;
  const normalize = (raw) => {
    if (!raw) return raw;
    try {
      const u = new URL(raw, location.href);
      if (excludeSearch) u.search = '';
      if (excludeHash) u.hash = '';
      return u.toString();
    } catch {
      return raw;
    }
  };
  const stripOrigin = (url) =>
    url === origin || (url && url.startsWith(origin + '/')) ? url.slice(origin.length) : url;
  let currentUrl = normalize(location.href);
  let currentRef = normalize(document.referrer);
  const payload = () => ({
    website,
    screen: screen.width + 'x' + screen.height,
    language: navigator.language,
    title: document.title,
    hostname: location.hostname,
    url: currentUrl,
    referrer: stripOrigin(currentRef),
  });
  const send = async (body, type = 'event') => {
    if (!website || (dnt && navigator.doNotTrack === '1')) return;
    const name = config('before-send');
    const callback = name ? window[name] : undefined;
    if (typeof callback === 'function') body = await Promise.resolve(callback(type, body));
    if (!body) return;
    await fetch(endpoint, {
      keepalive: true,
      method: 'POST',
      body: JSON.stringify({ type, payload: body }),
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
    });
  };
  const onChange = (url) => {
    if (!url) return;
    currentRef = currentUrl;
    currentUrl = normalize(url);
    if (currentUrl !== currentRef) setTimeout(() => send(payload()), 300);
  };
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      onChange(args[2]);
      return result;
    };
  }
  const init = () => send(payload());
  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init, { once: true });
})();`;

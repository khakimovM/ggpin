import type { BrowserContext, Page, Route } from '@playwright/test';

// The shared `page.route` fakes answer asynchronously: they read request headers (a round trip to
// the browser), wait on a test's gate or delay on purpose. A request the page sends just before its
// test ends leaves such a callback running while the context closes; the next call then throws
// "Target page, context or browser has been closed", and Playwright reports it against whichever
// test that worker runs next.
//
// Playwright's own advice for that is `page.unrouteAll({ behavior: 'ignoreErrors' })` before the
// end of each test. These fakes are plain installers called from the specs, with no teardown of
// their own, so the same rule is kept at the source instead: an error thrown after the page or
// context has closed is dropped. Any error while the target is open still fails the test.
// (The client-side error class is not exported and its `name` is plain "Error", so the closing is
// read from the target itself, not from the error.)
//
// A context closes its pages first and emits its own 'close' last, so for a context route the
// request's own page is checked too. A dropped callback never marks its route handled: a later
// `unroute`/`unrouteAll()` in the default "wait" mode on that closed target would wait forever
// (no spec calls either).

type RouteTarget = Page | BrowserContext;
type RouteUrl = Parameters<Page['route']>[0];
type RouteHandler = (route: Route) => unknown;

const isPage = (target: RouteTarget): target is Page => 'mainFrame' in target;

/** Whether the page that sent the request has closed (false when it cannot be told). */
function requestPageClosed(route: Route): boolean {
  try {
    return route.request().frame().page().isClosed();
  } catch {
    // A service-worker request has no frame: keep the error.
    return false;
  }
}

/** `target.route(url, handler)`, but a callback still running when the target closes ends quietly. */
export async function routeUntilClosed(
  target: RouteTarget,
  url: RouteUrl,
  handler: RouteHandler,
): Promise<void> {
  let closed = false;
  const markClosed = () => {
    closed = true;
  };
  // Page and BrowserContext type their 'close' listeners differently: one call per kind.
  if (isPage(target)) target.once('close', markClosed);
  else target.once('close', markClosed);
  const isClosed = () => closed || (isPage(target) && target.isClosed());
  await target.route(url, async (route) => {
    try {
      await handler(route);
    } catch (error) {
      if (isClosed() || requestPageClosed(route)) return;
      throw error;
    }
  });
}

// E2E-only stand-in for the Umami tracker (phase 8 S5). In production nginx serves /stats/ from
// the Umami container (phase 11) and this route is never reached; without E2E_PROBES=1 it is a 404.
//
// The e2e build has an analytics website id, so every marketing page asks for /stats/script.js.
// This answers with a script that does nothing, so pages load without a failed request in the
// console; e2e/site/analytics.spec.ts replaces it per test with a tracker that sends beacons.

export const dynamic = 'force-dynamic';

export function GET(): Response {
  if (process.env.E2E_PROBES !== '1') return new Response(null, { status: 404 });
  return new Response('/* e2e: analytics tracker stand-in, sends nothing */\n', {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

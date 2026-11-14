// Phase 7 S11, check 4: the production build refuses the mock API and ships none of it.
//
// Run from apps/web:  node scripts/prod-build-check.mjs
// It rebuilds `.next`, so do not run it while an e2e server is using that build.
//
// 1. NODE_ENV=production `next build` with NEXT_PUBLIC_API_MOCKS filled  -> must FAIL (the guard).
// 1b. the same with a REMOVED group (`wallet`, `payments`: real since phase 4) -> must FAIL (unknown group).
// 1c. NEXT_PUBLIC_ANALYTICS_SITE_ID that is not a UUID (phase 8 S5)     -> must FAIL.
// 2. the same with NEXT_PUBLIC_API_MOCKS empty                           -> must PASS.
// 3. `.next/static` and `.next/server` hold no mock identifier or fixture literal; a literal that
//    the production bundle does contain is searched in the same way, to prove the search works.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// A host name nothing else in the app contains, so finding it in the browser bundle is conclusive.
const INTERNAL_API = 'http://internal-api.example.test:5000/api/v1';
const ENV = {
  ...process.env,
  NODE_ENV: 'production',
  NEXT_PUBLIC_API_URL: 'https://api.example.test/api/v1',
  NEXT_PUBLIC_SITE_URL: 'https://example.test',
  NEXT_PUBLIC_BOT_USERNAME: 'ggpin_e2e_bot',
  NEXT_PUBLIC_SUPPORT_URL: '',
  NEXT_PUBLIC_TELEGRAM_CHANNEL_URL: 'https://t.me/ggpin_e2e_channel',
  // Analytics off, as in every build until the Umami container exists (phase 11).
  NEXT_PUBLIC_ANALYTICS_SITE_ID: '',
  // Server-only: must never reach a browser bundle (check below).
  API_INTERNAL_URL: INTERNAL_API,
  NEXT_TELEMETRY_DISABLED: '1',
};
const FORBIDDEN = [
  'mockTransport',
  'createMockTransport',
  'MOCK_PAY_TOKEN',
  'mockrecipienttoken',
  'mockpaytoken',
  // The wallet and payments mocks were removed in phase 7 S12-a: no trace of them may come back.
  'walletRoutes',
  'paymentsRoutes',
  'MOCK_WALLET',
  'MOCK_PAYMENT_METHODS',
  'ledger_mock',
  'intent_mock',
  'mock/handlers/wallet',
  'mock/handlers/payments',
  // Literals of the remaining mock fixtures (orders, quotes, recipients): identifier names do not
  // survive minification, string literals do.
  'order_mock_',
  'quote_mock_',
];
// Written in client.ts as the production branch of the mock loader: it must be in the bundle.
const CONTROL = 'does not exist in production builds';

function build(mocks, extra = {}) {
  const run = spawnSync('npx', ['next', 'build'], {
    env: { ...ENV, NEXT_PUBLIC_API_MOCKS: mocks, ...extra },
    encoding: 'utf8',
    shell: true,
  });
  return { code: run.status, out: `${run.stdout}\n${run.stderr}` };
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

function hits(needle, roots = ['.next/static', '.next/server']) {
  const found = [];
  for (const root of roots) {
    for (const file of files(root)) {
      if (readFileSync(file, 'latin1').includes(needle)) found.push(file);
    }
  }
  return found;
}

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};

const filled = build('orders,quotes');
check(filled.code !== 0, `build with NEXT_PUBLIC_API_MOCKS filled fails (exit ${filled.code})`);
check(
  filled.out.includes('NEXT_PUBLIC_API_MOCKS must be empty in a production build'),
  'the failure is the mock guard message',
);

for (const removed of ['wallet', 'payments']) {
  const run = build(removed);
  check(run.code !== 0, `build with the removed group "${removed}" fails (exit ${run.code})`);
  check(
    run.out.includes('Invalid option') && run.out.includes('recipients'),
    `the failure for "${removed}" names the valid groups (an unknown group, not a silent no-op)`,
  );
}

// The analytics id is written into a script attribute on every marketing page: a value that is not
// a UUID (here: markup) must stop the build, not reach the HTML.
const badAnalytics = build('', { NEXT_PUBLIC_ANALYTICS_SITE_ID: '"><b>x</b>' });
check(
  badAnalytics.code !== 0,
  `build with a non-UUID NEXT_PUBLIC_ANALYTICS_SITE_ID fails (exit ${badAnalytics.code})`,
);
check(
  badAnalytics.out.includes('NEXT_PUBLIC_ANALYTICS_SITE_ID'),
  'the failure names NEXT_PUBLIC_ANALYTICS_SITE_ID',
);

const empty = build('');
check(empty.code === 0, `build with NEXT_PUBLIC_API_MOCKS empty passes (exit ${empty.code})`);
if (empty.code !== 0) console.log(empty.out.slice(-1500));

if (empty.code === 0) {
  check(hits(CONTROL).length > 0, `control literal "${CONTROL}" is found in .next (search works)`);
  for (const needle of FORBIDDEN) {
    const found = hits(needle);
    check(
      found.length === 0,
      `no "${needle}" in .next/static or .next/server${found.length ? `: ${found.slice(0, 3).join(', ')}` : ''}`,
    );
  }

  // NOTE (phase 8 S0-A): catalog-server.ts is not yet imported by any route, so for now this check
  // proves little beyond "the variable is not NEXT_PUBLIC". It becomes meaningful in S2, which
  // wires the module into the landing: add then a control that the module IS in .next/server (for
  // example its "[site-catalog]" log prefix), so a leak search over a build that lacks the module
  // cannot pass by accident.
  // API_INTERNAL_URL is read by the server at run time; it must not be inlined into a browser
  // bundle the way NEXT_PUBLIC_* values are. The public API URL is searched as the control: it IS
  // inlined, so finding it proves the search works.
  const PUBLIC_API = ENV.NEXT_PUBLIC_API_URL;
  check(
    hits(PUBLIC_API, ['.next/static']).length > 0,
    `control: the public API URL is found in .next/static (search works)`,
  );
  const leaked = hits(new URL(INTERNAL_API).host, ['.next/static']);
  check(
    leaked.length === 0,
    `API_INTERNAL_URL is not in .next/static (server-only)${leaked.length ? `: ${leaked.slice(0, 3).join(', ')}` : ''}`,
  );
}

console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);

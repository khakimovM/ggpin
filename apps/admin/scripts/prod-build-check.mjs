// Phase 9 S3: the admin production build refuses the mock API and ships none of it.
//
// Run from apps/admin:  node scripts/prod-build-check.mjs
// It rebuilds `dist`, so do not run it while something serves that folder.
//
// 1. `vite build` with VITE_API_MOCKS filled          -> must FAIL (the build-time guard).
// 2. `vite build` with a plain-http remote API URL     -> must FAIL (https in production).
// 3. `vite build` with NODE_ENV=development             -> must FAIL (a dev build keeps dev code).
// 4. `vite build` with VITE_API_MOCKS empty            -> must PASS.
// 5. `dist` holds no mock identifier, fixture literal or dev-only route; a literal the production
//    bundle does contain is searched the same way, to prove the search works.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ENV = {
  ...process.env,
  NODE_ENV: 'production',
  VITE_API_URL: 'https://api.example.test/api/v1',
  VITE_ENV_LABEL: 'PRODUCTION',
};

const FORBIDDEN = [
  // The mock transport and its state (identifier names may survive in error texts and keys).
  'createMockTransport',
  'mockTransport',
  'ggpin-admin-mock',
  // Fixture literals: string literals survive minification.
  'ggpin_mock_bot',
  'cmadminownermock',
  'Dilshod K.',
  'Malika R.',
  // S5 read-screen fixtures (users, orders, payments, bank messages).
  'sardor_r',
  '5521039917',
  'UQAi7Kx0hot',
  '<b>Diqqat</b>',
  // The dev-only theme probe page of e2e/theme.spec.ts.
  'dev/theme-probe',
  'probe-danger',
  'probe-premium',
];
// Written in src/lib/api/client.ts as the production branch of the mock loader.
const CONTROL = 'does not exist in production builds';

// npx is a .cmd shim on Windows, which spawn can start only through a shell; there the command is
// one fixed string (args next to `shell: true` are deprecated, DEP0190). Elsewhere: no shell.
const WINDOWS = process.platform === 'win32';

function build(extra) {
  const options = { env: { ...ENV, ...extra }, encoding: 'utf8', shell: WINDOWS };
  const run = WINDOWS
    ? spawnSync('npx vite build', options)
    : spawnSync('npx', ['vite', 'build'], options);
  return { code: run.status, out: `${run.stdout}\n${run.stderr}` };
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

function hits(needle) {
  return [...files('dist')].filter((file) => readFileSync(file, 'latin1').includes(needle));
}

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};

const mocked = build({ VITE_API_MOCKS: 'auth' });
check(mocked.code !== 0, `build with VITE_API_MOCKS filled fails (exit ${mocked.code})`);
check(
  mocked.out.includes('VITE_API_MOCKS must be empty in a production build'),
  'the failure is the mock guard message',
);

const plainHttp = build({ VITE_API_MOCKS: '', VITE_API_URL: 'http://api.example.test/api/v1' });
check(plainHttp.code !== 0, `build with a plain-http remote API fails (exit ${plainHttp.code})`);
check(plainHttp.out.includes('must use https'), 'the failure names the https rule');

const devNodeEnv = build({ VITE_API_MOCKS: '', NODE_ENV: 'development' });
check(devNodeEnv.code !== 0, `build with NODE_ENV=development fails (exit ${devNodeEnv.code})`);
check(
  devNodeEnv.out.includes('NODE_ENV must be "production"'),
  'the failure is the NODE_ENV guard message',
);

const empty = build({ VITE_API_MOCKS: '' });
check(empty.code === 0, `build with VITE_API_MOCKS empty passes (exit ${empty.code})`);
if (empty.code !== 0) console.log(empty.out.slice(-1500));

if (empty.code === 0) {
  check(hits(CONTROL).length > 0, `control literal "${CONTROL}" is found in dist (search works)`);
  check(
    hits(ENV.VITE_API_URL).length > 0,
    'control: the API URL is inlined in dist (search works)',
  );
  for (const needle of FORBIDDEN) {
    const found = hits(needle);
    check(
      found.length === 0,
      `no "${needle}" in dist${found.length ? `: ${found.slice(0, 3).join(', ')}` : ''}`,
    );
  }
  check(
    !existsSourceMap(),
    'no source maps in dist (build.sourcemap is false: the source is not published)',
  );
  // Same note as apps/web (phase 8 S6 audit L-2): the @repo/shared barrel carries the NAMES of the
  // secrets (never values) until the `@repo/shared/env-secrets` subpath (phase 11).
  const names = ['WORKER_ONLY_SECRETS', 'TON_MNEMONIC_ENC', 'BANK_FEED_'].filter(
    (name) => hits(name).length > 0,
  );
  console.log(`INFO  secret names in the admin bundle (phase 11): ${names.join(', ') || 'none'}`);
}

function existsSourceMap() {
  return [...files('dist')].some((file) => file.endsWith('.map'));
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nadmin prod-build-check: all checks passed');

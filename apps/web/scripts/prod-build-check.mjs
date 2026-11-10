// Phase 7 S11, check 4: the production build refuses the mock API and ships none of it.
//
// Run from apps/web:  node scripts/prod-build-check.mjs
// It rebuilds `.next`, so do not run it while an e2e server is using that build.
//
// 1. NODE_ENV=production `next build` with NEXT_PUBLIC_API_MOCKS filled  -> must FAIL (the guard).
// 2. the same with NEXT_PUBLIC_API_MOCKS empty                           -> must PASS.
// 3. `.next/static` and `.next/server` hold no mock identifier or fixture literal; a literal that
//    the production bundle does contain is searched in the same way, to prove the search works.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ENV = {
  ...process.env,
  NODE_ENV: 'production',
  NEXT_PUBLIC_API_URL: 'https://api.example.test/api/v1',
  NEXT_PUBLIC_SITE_URL: 'https://example.test',
  NEXT_PUBLIC_BOT_USERNAME: 'ggpin_e2e_bot',
  NEXT_PUBLIC_SUPPORT_URL: '',
};
const FORBIDDEN = [
  'mockTransport',
  'createMockTransport',
  'MOCK_PAY_TOKEN',
  'mockrecipienttoken',
  'mockpaytoken',
];
// Written in client.ts as the production branch of the mock loader: it must be in the bundle.
const CONTROL = 'does not exist in production builds';

function build(mocks) {
  const run = spawnSync('npx', ['next', 'build'], {
    env: { ...ENV, NEXT_PUBLIC_API_MOCKS: mocks },
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

function hits(needle) {
  const found = [];
  for (const root of ['.next/static', '.next/server']) {
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

const filled = build('wallet,orders,payments');
check(filled.code !== 0, `build with NEXT_PUBLIC_API_MOCKS filled fails (exit ${filled.code})`);
check(
  filled.out.includes('NEXT_PUBLIC_API_MOCKS must be empty in a production build'),
  'the failure is the mock guard message',
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
}

console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);

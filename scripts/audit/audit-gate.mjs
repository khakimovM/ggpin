#!/usr/bin/env node
// CI gate around `npm audit`: fails on any high/critical advisory in the production tree unless an
// unexpired entry of .github/audit-allowlist.json names that exact GHSA id, package and install
// path. Moderate and lower are printed but never fail. `npm audit` itself has no per-advisory
// ignore, which is why this wrapper exists (owner decision D-75).
//
// Usage:
//   node scripts/audit/audit-gate.mjs                 runs `npm audit --json --omit=dev`
//   node scripts/audit/audit-gate.mjs --input a.json  judges a saved report (tests, debugging)
//   options: --allowlist <file> (default .github/audit-allowlist.json), --today YYYY-MM-DD
//   Under CI (CI set and not "false"/"0") --input and --today are refused: CI judges a live audit
//   on the real date only.
// Exit codes: 0 pass, 1 blocked, 2 bad input (npm failed, unreadable report or allowlist).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { evaluate, isIsoDate } from './evaluate.mjs';
import { runNpmAudit } from './npm-audit.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJson(label, text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(`audit-gate: ${label} is not valid JSON (${err.message})`);
    process.exit(2);
  }
}

function bail(message) {
  console.error(`audit-gate: ${message}`);
  process.exit(2);
}

function readText(label, file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    return bail(`cannot read the ${label} ${file} (${err.message})`);
  }
}

const fmt = (f) =>
  `  ${f.severity.padEnd(8)} ${f.id.padEnd(21)} ${f.path}${f.title ? `\n           ${f.title}` : ''}`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      input: { type: 'string' },
      allowlist: { type: 'string', default: resolve(ROOT, '.github', 'audit-allowlist.json') },
      today: { type: 'string' },
    },
  }));
} catch (err) {
  bail(err.message);
}
const ciEnv = process.env.CI;
if (ciEnv && ciEnv !== 'false' && ciEnv !== '0') {
  if (values.input !== undefined) bail('--input is refused under CI (CI must audit the real tree)');
  if (values.today !== undefined) bail('--today is refused under CI (CI must use the real date)');
}
values.today ??= new Date().toISOString().slice(0, 10);
// An empty or impossible --today would make every review date look unexpired.
if (!isIsoDate(values.today)) bail(`--today must be a real YYYY-MM-DD date, got "${values.today}"`);

function liveAudit() {
  const res = runNpmAudit(ROOT);
  if (res.stderr) console.error(res.stderr);
  return res.error ? bail(res.error) : res.stdout;
}

const reportText =
  values.input === undefined ? liveAudit() : readText('audit report', values.input);
const report = readJson('npm audit output', reportText);
const allowlist = readJson('allowlist', readText('allowlist', values.allowlist));
const r = evaluate(report, allowlist, values.today);

const counts = report?.metadata?.vulnerabilities;
if (counts) {
  console.log(
    `npm audit (--omit=dev): critical ${counts.critical}, high ${counts.high}, moderate ${counts.moderate}, low ${counts.low}, info ${counts.info}`,
  );
}
if (r.reported.length) {
  console.log(`\nReported only (moderate or lower, not blocking): ${r.reported.length}`);
  r.reported.forEach((f) => console.log(fmt(f)));
}
if (r.allowed.length) {
  console.log(`\nAllowed by the allowlist: ${r.allowed.length}`);
  r.allowed.forEach((f) =>
    console.log(`${fmt(f)}\n           ${f.decision}, review by ${f.reviewBy}`),
  );
}
if (r.unused.length) {
  console.log(`\nWarning: allowlist entries that matched nothing (remove them):`);
  r.unused.forEach((e) => console.log(`  ${e.id} ${e.path} (${e.decision})`));
}
if (r.errors.length) {
  console.log(`\nERROR: ${r.errors.length} problem(s) with the input:`);
  r.errors.forEach((e) => console.log(`  ${e}`));
}
if (r.expired.length) {
  console.log(
    `\nBLOCKED: ${r.expired.length} allowlist entr(y/ies) past the review date (today ${values.today}):`,
  );
  r.expired.forEach((e) =>
    console.log(`  ${e.id} ${e.path} (${e.decision}), review by ${e.reviewBy}`),
  );
}
if (r.failures.length) {
  console.log(`\nBLOCKED: ${r.failures.length} high/critical finding(s) not in the allowlist:`);
  r.failures.forEach((f) => console.log(fmt(f)));
}
console.log(r.ok ? '\naudit-gate: PASS' : '\naudit-gate: FAIL');
process.exit(r.errors.length ? 2 : r.ok ? 0 : 1);

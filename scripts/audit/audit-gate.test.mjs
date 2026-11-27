// node --test scripts/audit — the npm audit gate on recorded-shape fixtures (no network, no npm audit).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluate, validateAllowlist } from './evaluate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_FILE = join(HERE, '..', '..', '.github', 'audit-allowlist.json');
const fixture = (name) => JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8'));
const allowlist = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'));
const TODAY = '2026-11-26';
const ZOD_PATH = 'node_modules/@ton/ton/node_modules/zod';

// The gate refuses --input/--today under CI, and these tests also run in CI: the child gets
// CI removed unless a test sets it on purpose.
function runWithEnv(extraEnv, ...args) {
  const env = { ...process.env, ...extraEnv };
  if (!('CI' in extraEnv)) delete env.CI;
  const res = spawnSync(process.execPath, [join(HERE, 'audit-gate.mjs'), ...args], {
    env,
    encoding: 'utf8',
  });
  return { code: res.status, out: res.stdout + res.stderr };
}
const run = (...args) => runWithEnv({}, ...args);
const gate = (fixtureName, ...extra) =>
  run('--input', join(HERE, 'fixtures', fixtureName), ...extra);

describe('the committed allowlist', () => {
  it('is valid and holds only the D-75 zod entry', () => {
    assert.deepEqual(validateAllowlist(allowlist), []);
    assert.equal(allowlist.entries.length, 1);
    assert.equal(allowlist.entries[0].id, 'GHSA-mrhx-c7xc-m3w5');
    assert.equal(allowlist.entries[0].path, ZOD_PATH);
    assert.equal(allowlist.entries[0].decision, 'D-75');
  });
});

describe('evaluate', () => {
  it('passes when the only high finding is the allowlisted zod under @ton/ton', () => {
    const r = evaluate(fixture('allowed-only.json'), allowlist, TODAY);
    assert.equal(r.ok, true);
    assert.deepEqual(r.failures, []);
    assert.deepEqual(
      r.allowed.map((f) => [f.id, f.path]),
      [['GHSA-mrhx-c7xc-m3w5', ZOD_PATH]],
    );
  });

  it('fails on the same advisory at another zod path', () => {
    const r = evaluate(fixture('zod-other-path.json'), allowlist, TODAY);
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.failures.map((f) => [f.id, f.path]),
      [['GHSA-mrhx-c7xc-m3w5', 'node_modules/zod']],
    );
  });

  it('fails on a new high advisory and names it', () => {
    const r = evaluate(fixture('new-high.json'), allowlist, TODAY);
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.failures.map((f) => [f.id, f.path]),
      [['GHSA-7589-6fvf-x4pw', 'node_modules/effect']],
    );
  });

  it('fails when an allowlist entry is past its review date, even if it matches', () => {
    const r = evaluate(fixture('allowed-only.json'), allowlist, '2099-01-01');
    assert.equal(r.ok, false);
    assert.equal(r.expired.length, 1);
    assert.deepEqual(r.failures, []);
  });

  it('accepts the review date itself', () => {
    const r = evaluate(fixture('allowed-only.json'), allowlist, allowlist.entries[0].reviewBy);
    assert.equal(r.ok, true);
  });

  it('reports moderate findings without failing', () => {
    const r = evaluate(fixture('moderate.json'), allowlist, TODAY);
    assert.equal(r.ok, true);
    assert.deepEqual(r.reported.map((f) => f.id).sort(), [
      'GHSA-7qx7-33qx-rqx2',
      'GHSA-f3mh-rxg3-f5g2',
    ]);
  });

  it('treats a critical advisory as failing', () => {
    const report = fixture('new-high.json');
    report.vulnerabilities.effect.via[0].severity = 'critical';
    assert.equal(evaluate(report, allowlist, TODAY).ok, false);
  });

  it('does not let the zod entry cover another GHSA on the same path', () => {
    const report = fixture('allowed-only.json');
    report.vulnerabilities.zod.via[0].url = 'https://github.com/advisories/GHSA-2222-3333-4444';
    const r = evaluate(report, allowlist, TODAY);
    assert.equal(r.ok, false);
    assert.equal(r.failures[0].id, 'GHSA-2222-3333-4444');
  });

  it('fails closed on a high metavuln that points at a package missing from the report', () => {
    const report = fixture('allowed-only.json');
    report.vulnerabilities['@ton/ton'].via = ['ghost'];
    assert.equal(evaluate(report, allowlist, TODAY).ok, false);
  });

  it('fails closed on an npm error report or an unknown format', () => {
    assert.equal(evaluate(fixture('npm-error.json'), allowlist, TODAY).ok, false);
    assert.equal(evaluate({ auditReportVersion: 1, advisories: {} }, allowlist, TODAY).ok, false);
    assert.equal(evaluate(null, allowlist, TODAY).ok, false);
  });

  it('rejects an allowlist entry with a wildcard path or missing fields', () => {
    const loose = { entries: [{ ...allowlist.entries[0], path: 'node_modules/**/zod' }] };
    assert.notDeepEqual(validateAllowlist(loose), []);
    const { reason: _reason, ...noReason } = allowlist.entries[0];
    assert.notDeepEqual(validateAllowlist({ entries: [noReason] }), []);
    assert.equal(evaluate(fixture('allowed-only.json'), loose, TODAY).ok, false);
  });

  it('passes a clean report and flags the unused entry', () => {
    const r = evaluate(fixture('clean.json'), allowlist, TODAY);
    assert.equal(r.ok, true);
    assert.equal(r.unused.length, 1);
  });
});

describe('audit-gate CLI', () => {
  it('exits 0 and prints the allowed entry', () => {
    const { code, out } = gate('allowed-only.json', '--today', TODAY);
    assert.equal(code, 0, out);
    assert.match(out, /Allowed by the allowlist: 1/);
    assert.match(out, /audit-gate: PASS/);
  });

  it('exits 1 on a new high advisory', () => {
    const { code, out } = gate('new-high.json', '--today', TODAY);
    assert.equal(code, 1, out);
    assert.match(out, /BLOCKED: 1 high\/critical finding/);
    assert.match(out, /GHSA-7589-6fvf-x4pw/);
  });

  it('exits 1 on an expired entry', () => {
    const { code, out } = gate('allowed-only.json', '--today', '2099-01-01');
    assert.equal(code, 1, out);
    assert.match(out, /past the review date/);
  });

  it('exits 2 when npm audit itself failed', () => {
    const { code, out } = gate('npm-error.json', '--today', TODAY);
    assert.equal(code, 2, out);
  });

  it('exits 2 when the report has vulnerabilities: null', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'audit-gate-')), 'null.json');
    writeFileSync(file, JSON.stringify({ auditReportVersion: 2, vulnerabilities: null }));
    const { code, out } = run('--input', file, '--today', TODAY);
    assert.equal(code, 2, out);
    assert.doesNotMatch(out, /TypeError/);
  });

  it('exits 2 when --input or --allowlist cannot be read', () => {
    const missing = join(HERE, 'fixtures', 'does-not-exist.json');
    assert.equal(run('--input', missing, '--today', TODAY).code, 2);
    assert.equal(run('--input', '', '--today', TODAY).code, 2);
    const { code, out } = gate('allowed-only.json', '--allowlist', missing, '--today', TODAY);
    assert.equal(code, 2, out);
    assert.match(out, /cannot read the allowlist/);
  });

  for (const bad of ['', '2027-02-31', '2027-13-01', '31.01.2027', 'tomorrow']) {
    it(`exits 2 on --today "${bad}" (never fails open)`, () => {
      const { code, out } = gate('allowed-only.json', '--today', bad);
      assert.equal(code, 2, out);
      assert.match(out, /--today must be a real YYYY-MM-DD date/);
    });
  }

  it('exits 2 on an unknown option', () => {
    assert.equal(gate('allowed-only.json', '--todya', TODAY).code, 2);
  });

  for (const ci of ['true', '1']) {
    it(`refuses --input and --today when CI=${ci}`, () => {
      const input = runWithEnv({ CI: ci }, '--input', join(HERE, 'fixtures', 'clean.json'));
      assert.equal(input.code, 2, input.out);
      assert.match(input.out, /--input is refused under CI/);
      const today = runWithEnv({ CI: ci }, '--today', TODAY, '--allowlist', 'missing.json');
      assert.equal(today.code, 2, today.out);
      assert.match(today.out, /--today is refused under CI/);
    });
  }

  it('accepts --input when CI is "false"', () => {
    const { code, out } = runWithEnv(
      { CI: 'false' },
      '--input',
      join(HERE, 'fixtures', 'allowed-only.json'),
      '--today',
      TODAY,
    );
    assert.equal(code, 0, out);
  });
});

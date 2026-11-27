// node --test scripts/audit — edge cases of the gate's decision logic on small inline reports.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addDays, advisoryId, evaluate, MAX_REVIEW_DAYS, validateAllowlist } from './evaluate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8'));
const allowlist = JSON.parse(
  readFileSync(join(HERE, '..', '..', '.github', 'audit-allowlist.json'), 'utf8'),
);
const TODAY = '2026-11-26';
const ZOD_PATH = 'node_modules/@ton/ton/node_modules/zod';

// Small inline reports for the edge cases (same v2 shape as the fixtures).
const adv = (id, severity, extra = {}) => ({
  source: 1100099,
  name: 'pkg',
  dependency: 'pkg',
  title: `advisory ${id}`,
  url: `https://github.com/advisories/${id}`,
  severity,
  range: '<1.0.0',
  ...extra,
});
const vuln = (name, severity, via, nodes = [`node_modules/${name}`]) => ({
  name,
  severity,
  isDirect: false,
  via,
  effects: [],
  range: '<1.0.0',
  nodes,
  fixAvailable: false,
});
// metadata as npm builds it: one count per vulnerabilities entry, by the entry's severity.
const countsOf = (vulns) => {
  const c = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  if (vulns && typeof vulns === 'object' && !Array.isArray(vulns)) {
    for (const v of Object.values(vulns)) {
      if (v && v.severity in c) c[v.severity] += 1;
      c.total += 1;
    }
  }
  return c;
};
const report = (vulnerabilities) => ({
  auditReportVersion: 2,
  vulnerabilities,
  metadata: { vulnerabilities: countsOf(vulnerabilities) },
});

describe('evaluate: report shape', () => {
  it('passes an empty vulnerabilities object', () => {
    const r = evaluate(report({}), allowlist, TODAY);
    assert.equal(r.ok, true);
    assert.deepEqual([r.failures, r.errors], [[], []]);
  });

  for (const [label, value] of [
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
  ]) {
    it(`reports bad input (not a TypeError) for vulnerabilities = ${label}`, () => {
      const r = evaluate(report(value), allowlist, TODAY);
      assert.equal(r.ok, false);
      assert.match(r.errors.join(), /vulnerabilities object/);
    });
  }

  it('reports bad input for a vulnerability entry that is not an object', () => {
    const r = evaluate(report({ zod: null }), allowlist, TODAY);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /vulnerabilities\.zod is not an object/);
  });

  for (const bad of ['', '2027-02-31', '2026-1-1', undefined]) {
    it(`reports bad input for today = ${JSON.stringify(bad)}`, () => {
      const r = evaluate(fixture('allowed-only.json'), allowlist, bad);
      assert.equal(r.ok, false);
      assert.match(r.errors.join(), /today: not a real YYYY-MM-DD date/);
    });
  }

  for (const bad of ['2027-02-31', '2027-13-01', 'soon', '2027/01/31']) {
    it(`rejects reviewBy ${bad}`, () => {
      const entry = { ...allowlist.entries[0], reviewBy: bad };
      assert.match(validateAllowlist({ entries: [entry] }).join(), /reviewBy/);
      assert.equal(evaluate(fixture('allowed-only.json'), { entries: [entry] }, TODAY).ok, false);
    });
  }
});

describe('evaluate: advisories and pointers', () => {
  it('fails an unexplained high entry (no advisory, no pointer)', () => {
    const r = evaluate(report({ a: vuln('a', 'high', []) }), allowlist, TODAY);
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.failures.map((f) => [f.id, f.name]),
      [['unexplained', 'a']],
    );
  });

  it('uses npm:<source> for an advisory without a GHSA url, and it cannot be allowlisted', () => {
    const noGhsa = adv('x', 'high', { url: null, source: 4242 });
    assert.equal(advisoryId(noGhsa), 'npm:4242');
    const r = evaluate(report({ a: vuln('a', 'high', [noGhsa]) }), allowlist, TODAY);
    assert.equal(r.ok, false);
    assert.equal(r.failures[0].id, 'npm:4242');
  });

  it('judges a via list that mixes a pointer and an own advisory', () => {
    const base = fixture('allowed-only.json');
    base.vulnerabilities['@ton/ton'].via = ['zod', adv('GHSA-2222-3333-4444', 'high')];
    const r = evaluate(base, allowlist, TODAY);
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.allowed.map((f) => f.path),
      [ZOD_PATH],
    );
    assert.deepEqual(
      r.failures.map((f) => [f.id, f.path]),
      [['GHSA-2222-3333-4444', 'node_modules/@ton/ton']],
    );
  });

  it('allows only the listed path when one package has several nodes', () => {
    const r = evaluate(fixture('zod-other-path.json'), allowlist, TODAY);
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.allowed.map((f) => f.path),
      [ZOD_PATH],
    );
    assert.deepEqual(
      r.failures.map((f) => f.path),
      ['node_modules/zod'],
    );
  });

  it('fails a pointer-only cycle that never reaches an advisory', () => {
    const r = evaluate(
      report({ a: vuln('a', 'high', ['b']), b: vuln('b', 'high', ['a']) }),
      allowlist,
      TODAY,
    );
    assert.equal(r.ok, false);
    assert.deepEqual(r.failures.map((f) => f.name).sort(), ['a', 'b']);
  });

  it('fails a high metavuln whose chain reaches only a moderate advisory', () => {
    const r = evaluate(
      report({
        a: vuln('a', 'high', ['b']),
        b: vuln('b', 'moderate', [adv('GHSA-2222-3333-5555', 'moderate')]),
      }),
      allowlist,
      TODAY,
    );
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.failures.map((f) => [f.id, f.name]),
      [['unexplained', 'a']],
    );
  });

  it('fails a high entry with a moderate advisory and a dangling pointer', () => {
    const r = evaluate(
      report({ a: vuln('a', 'high', [adv('GHSA-2222-3333-6666', 'moderate'), 'ghost']) }),
      allowlist,
      TODAY,
    );
    assert.equal(r.ok, false);
    assert.equal(r.failures[0].id, 'unexplained');
  });

  it('fails a dangling pointer deeper in the chain, even past a high advisory', () => {
    const base = fixture('allowed-only.json');
    base.vulnerabilities.zod.via.push('ghost');
    const r = evaluate(base, allowlist, TODAY);
    assert.equal(r.ok, false);
    assert.deepEqual(r.failures.map((f) => f.name).sort(), ['@ton/ton', 'zod']);
  });
});

describe('evaluate: review horizon and metadata', () => {
  it(`accepts reviewBy exactly ${MAX_REVIEW_DAYS} days ahead and refuses one day more`, () => {
    const at = { ...allowlist.entries[0], reviewBy: addDays(TODAY, MAX_REVIEW_DAYS) };
    assert.deepEqual(validateAllowlist({ entries: [at] }, TODAY), []);
    const past = { ...at, reviewBy: addDays(TODAY, MAX_REVIEW_DAYS + 1) };
    assert.match(validateAllowlist({ entries: [past] }, TODAY).join(), /more than 180 days/);
    const r = evaluate(fixture('allowed-only.json'), { entries: [past] }, TODAY);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /more than 180 days/);
  });

  it('crosses a leap day correctly', () => {
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2026-11-26', 180), '2027-05-25');
  });

  it('reports bad input when metadata counts high/critical but no finding was read', () => {
    const base = report({});
    base.metadata.vulnerabilities.high = 2;
    const r = evaluate(base, allowlist, TODAY);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /format changed/);
  });

  it('reports bad input when metadata.vulnerabilities is missing', () => {
    const base = fixture('allowed-only.json');
    delete base.metadata;
    const r = evaluate(base, allowlist, TODAY);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /metadata/);
  });

  it('does not flag the count check when only moderate findings exist', () => {
    const r = evaluate(fixture('moderate.json'), allowlist, TODAY);
    assert.deepEqual(r.errors, []);
  });
});

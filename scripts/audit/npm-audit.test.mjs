// node --test scripts/audit — how the gate treats the npm audit process itself (fake spawn).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUDIT_TIMEOUT_MS, runNpmAudit } from './npm-audit.mjs';

const fakeSpawn = (result) => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { stdout: '{"ok":1}', stderr: '', status: 0, signal: null, ...result };
  };
  return { spawn, calls };
};

describe('runNpmAudit', () => {
  it('runs npm audit --json --omit=dev with a 5 minute timeout', () => {
    const { spawn, calls } = fakeSpawn({});
    runNpmAudit('/repo', spawn);
    assert.equal(calls[0].cmd, 'npm');
    assert.deepEqual(calls[0].args, ['audit', '--json', '--omit=dev']);
    assert.equal(calls[0].opts.timeout, AUDIT_TIMEOUT_MS);
    assert.equal(AUDIT_TIMEOUT_MS, 300_000);
    assert.equal(calls[0].opts.cwd, '/repo');
  });

  for (const status of [0, 1]) {
    it(`returns stdout for exit status ${status}`, () => {
      const res = runNpmAudit('/repo', fakeSpawn({ status }).spawn);
      assert.equal(res.error, null);
      assert.equal(res.stdout, '{"ok":1}');
    });
  }

  it('is an error when the process could not start', () => {
    const res = runNpmAudit('/repo', fakeSpawn({ error: new Error('ENOENT'), status: null }).spawn);
    assert.match(String(res.error), /could not run npm audit \(ENOENT\)/);
  });

  it('is an error when the process was killed (timeout)', () => {
    const res = runNpmAudit('/repo', fakeSpawn({ signal: 'SIGTERM', status: null }).spawn);
    assert.match(String(res.error), /killed by SIGTERM/);
  });

  for (const status of [2, 127, null]) {
    it(`is an error for exit status ${status}`, () => {
      const res = runNpmAudit('/repo', fakeSpawn({ status }).spawn);
      assert.match(String(res.error), /npm audit exited/);
    });
  }
});

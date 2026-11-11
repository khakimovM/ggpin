import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The guard the real API, worker and inject tool of the e2e journeys run under: no connection may
// leave this machine. Tested in a child process with the same preload as the harness (`--require`
// in NODE_OPTIONS). The targets are names under `.invalid` (RFC 2606: they never resolve) and
// addresses of the documentation ranges TEST-NET-1 and 2001:db8::/32 (RFC 5737, RFC 3849: never
// routed), so even a guard that failed would send nothing to a real host.

const GUARD = path
  .resolve(__dirname, '../../e2e/support/loopback-only.cjs')
  .split(path.sep)
  .join('/');

function run(script: string) {
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NODE_OPTIONS: `--require "${GUARD}"` },
  });
  return `${result.stdout}${result.stderr}`;
}

const attempt = (host: string, how: 'net' | 'tls' | 'http2' = 'net') => `
  const net = require('node:net');
  const tls = require('node:tls');
  const http2 = require('node:http2');
  const done = (text) => { console.log(text); process.exit(0); };
  const target = { host: ${JSON.stringify(host)}, port: 443 };
  const socket = ${
    how === 'net'
      ? 'net.connect(target)'
      : how === 'tls'
        ? 'tls.connect(target)'
        : `http2.connect('https://' + (target.host.includes(':') ? '[' + target.host + ']' : target.host))`
  };
  socket.on('error', (error) => done('ERROR ' + error.message));
  socket.on('connect', () => done('CONNECTED'));
  setTimeout(() => done('TIMEOUT'), 8000);
`;

const blocked = (output: string, host: string) => {
  expect(output).toContain(`LOOPBACK_GUARD blocked a connection to ${host}`);
  expect(output).not.toContain('CONNECTED');
  expect(output).not.toContain('TIMEOUT');
};

describe('the loopback guard of the real-process journeys', () => {
  it('announces itself, so that a run without it can be told', () => {
    expect(run('')).toMatch(/LOOPBACK_GUARD active pid=\d+/);
  });

  it.each([
    'api.telegram.org.invalid',
    'fragment.com.invalid',
    '192.0.2.1',
    '198.51.100.7',
    '2001:db8::1',
  ])('refuses %s over TCP before any lookup, and says so on stderr', (host) => {
    blocked(run(attempt(host)), host);
  });

  it.each(['tls', 'http2'] as const)('refuses a %s connection too', (how) => {
    blocked(run(attempt('api.telegram.org.invalid', how)), 'api.telegram.org.invalid');
    blocked(run(attempt('192.0.2.1', how)), '192.0.2.1');
  });

  it('refuses the same through fetch', () => {
    const output = run(`fetch('https://api.telegram.org.invalid/').catch(() => process.exit(0));`);
    expect(output).toContain('LOOPBACK_GUARD blocked a connection to api.telegram.org.invalid');
  });

  it("reads a string port the way Node does: '0x1BB' is port 443, not a socket path", () => {
    const output = run(`
      const net = require('node:net');
      const socket = net.connect('0x1BB', '192.0.2.1');
      socket.on('error', () => process.exit(0));
    `);
    blocked(output, '192.0.2.1');
  });

  it('refuses a name that resolves to a non-local address (a custom lookup)', () => {
    const output = run(`
      const net = require('node:net');
      const lookup = (host, options, callback) =>
        options && options.all ? callback(null, [{ address: '192.0.2.1', family: 4 }]) : callback(null, '192.0.2.1', 4);
      const socket = net.connect({ host: 'localhost', port: 443, lookup });
      socket.on('error', (error) => { console.log('ERROR ' + error.message); process.exit(0); });
      socket.on('connect', () => { console.log('CONNECTED'); process.exit(0); });
    `);
    expect(output).toContain('LOOPBACK_GUARD blocked localhost resolving to 192.0.2.1');
    expect(output).not.toContain('CONNECTED');
  });

  it('covers a worker thread', () => {
    const output = run(`
      const { Worker } = require('node:worker_threads');
      const code = "const net = require('node:net'); const s = net.connect({ host: '192.0.2.1', port: 443 }); s.on('error', () => process.exit(0));";
      new Worker(code, { eval: true }).on('exit', () => process.exit(0));
    `);
    blocked(output, '192.0.2.1');
  });

  it('covers a child process (NODE_OPTIONS is inherited)', () => {
    const output = run(`
      const { spawnSync } = require('node:child_process');
      const child = "const net = require('node:net'); const s = net.connect({ host: '192.0.2.1', port: 443 }); s.on('error', () => process.exit(0));";
      const result = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 20000 });
      process.stdout.write(result.stdout + result.stderr);
    `);
    blocked(output, '192.0.2.1');
  });

  it('lets this machine through: a local server is reached by name and by address', () => {
    const output = run(`
      const net = require('node:net');
      const server = net.createServer((socket) => socket.end()).listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        const byName = net.connect({ host: 'localhost', port }, () => {
          byName.destroy();
          const byAddress = net.connect({ host: '127.0.0.1', port }, () => {
            console.log('LOCAL_OK');
            process.exit(0);
          });
        });
      });
    `);
    expect(output).toContain('LOCAL_OK');
    expect(output).not.toMatch(/LOOPBACK_GUARD blocked/);
  });
});

// Preloaded with `--require` (and put in NODE_OPTIONS, so worker threads and child processes load
// it too) into every REAL process the journeys start: the API, the worker and the bank-feed inject
// tool. It refuses any TCP connection to a host that is not this machine, so nothing can reach
// api.telegram.org, a bank, Fragment or a TON node whatever the code or the environment says.
//
// What it covers: everything built on net.Socket#connect in the main thread, worker threads and
// child processes: TCP, TLS, HTTP/1 and HTTP/2, fetch (undici), pg, ioredis. A refused connection
// is written to stderr as `LOOPBACK_GUARD blocked a connection to <host>`; the harness collects
// those lines as they stream in and the journeys assert there are none.
// What it does NOT cover: UDP (dgram) and DNS queries sent by the c-ares resolver (dns.resolve*);
// no code of the API or worker uses them to reach anything, but this is not a firewall.
//
// Two checks: the host NAME given to connect() is checked before any lookup, so a name such as
// api.telegram.org is refused without a single packet; and the lookup itself is wrapped, so a name
// that does resolve (a hosts-file or DNS trick) to a non-local address is refused too.
//
// On load it writes `LOOPBACK_GUARD active pid=<pid>`: a run whose output lacks it was NOT guarded.
'use strict';

const dns = process.getBuiltinModule('node:dns');
const net = process.getBuiltinModule('node:net');

const LOOPBACK_NAMES = new Set(['localhost', '::1', '::ffff:127.0.0.1']);
const connect = net.Socket.prototype.connect;

function isLoopbackAddress(address) {
  return (
    typeof address === 'string' &&
    (address === '::1' || /^127\./.test(address) || /^::ffff:127\./i.test(address))
  );
}

function isLocalHost(host) {
  return LOOPBACK_NAMES.has(host) || isLoopbackAddress(host);
}

// Mirrors net.connect's own reading of its arguments: a string is a PORT when it reads as a number
// ('443', '0x1BB', ''), and a socket path (IPC) only when it does not.
function isPortLike(value) {
  return typeof value === 'number' || (typeof value === 'string' && Number(value) >= 0);
}

/** The options object net.connect normalised, or the host a plain (port, host) call names. */
function optionsOf(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === 'object') return { options: first, host: first.host };
  if (isPortLike(first))
    return { options: null, host: typeof args[1] === 'string' ? args[1] : undefined };
  return { options: null, host: null }; // a socket path: local
}

function refuse(socket, host) {
  process.stderr.write(`LOOPBACK_GUARD blocked a connection to ${String(host)}\n`);
  const error = new Error(`LOOPBACK_GUARD: a connection to ${String(host)} was blocked`);
  queueMicrotask(() => socket.destroy(error));
  return socket;
}

function guardedLookup(inner) {
  return (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options;
    inner(hostname, opts, (error, address, family) => {
      if (error) return done(error);
      const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
      const stranger = addresses.find((entry) => !isLoopbackAddress(entry));
      if (stranger !== undefined) {
        process.stderr.write(
          `LOOPBACK_GUARD blocked ${String(hostname)} resolving to ${stranger}\n`,
        );
        return done(
          new Error(`LOOPBACK_GUARD: ${String(hostname)} resolves to a non-local address`),
        );
      }
      return done(null, address, family);
    });
  };
}

net.Socket.prototype.connect = function guardedConnect(...args) {
  const { options, host } = optionsOf(args);
  if (host === null) return connect.apply(this, args); // IPC
  const named = host === undefined || host === '' ? 'localhost' : host;
  if (!isLocalHost(named)) return refuse(this, named);
  if (options !== null && !net.isIP(named)) {
    options.lookup = guardedLookup(
      typeof options.lookup === 'function' ? options.lookup : dns.lookup,
    );
  }
  return connect.apply(this, args);
};

process.stderr.write(`LOOPBACK_GUARD active pid=${String(process.pid)}\n`);

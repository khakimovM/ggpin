// Prunes an installed node_modules tree down to what the given workspaces need at run time.
// Used by apps/api/Dockerfile (deps-prod stage) after `npm ci --omit=dev`.
//
// Why: npm installs OPTIONAL peer dependencies the lockfile resolved, and their whole trees.
// @prisma/client lists `prisma` (the CLI) as an optional peer, so a production install still gets the
// CLI, typescript, effect, better-sqlite3, mysql2, react (Prisma Studio), ... `--omit=peer` does not
// help: those packages are not flagged as peers in the lockfile, because other workspaces depend on
// them directly. This script walks the lockfile from the given workspaces along `dependencies`,
// `optionalDependencies` and REQUIRED `peerDependencies` (never optional peers), using Node's
// node_modules lookup, and deletes every installed package that walk does not reach.
//
// Usage: node prune-deps.mjs <root> <workspace dir>...   e.g.  node prune-deps.mjs /app apps/api packages/db
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const [root, ...starts] = process.argv.slice(2);
if (!root || starts.length === 0) {
  process.stderr.write('usage: node prune-deps.mjs <root> <workspace dir>...\n');
  process.exit(2);
}
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages;

// The directory Node searches next, going up from a lockfile location.
function parent(dir) {
  const idx = dir.lastIndexOf('/node_modules/');
  if (idx >= 0) return dir.slice(0, idx);
  if (dir.startsWith('node_modules/')) return '';
  return dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
}

function resolve(from, name) {
  let dir = from;
  for (;;) {
    const key = `${dir === '' ? '' : `${dir}/`}node_modules/${name}`;
    if (lock[key] !== undefined) return key;
    if (dir === '') return null;
    dir = parent(dir);
  }
}

const kept = new Set();
const queue = [...starts];
const missingRequired = [];
while (queue.length > 0) {
  const loc = queue.pop();
  if (loc === undefined || kept.has(loc)) continue;
  kept.add(loc);
  const entry = lock[loc];
  if (entry === undefined) continue;
  if (entry.link === true && typeof entry.resolved === 'string') {
    queue.push(entry.resolved);
    continue;
  }
  const optionalPeers = new Set(
    Object.entries(entry.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta.optional === true)
      .map(([name]) => name),
  );
  const edges = [
    ...Object.keys(entry.dependencies ?? {}).map((name) => [name, false]),
    ...Object.keys(entry.optionalDependencies ?? {}).map((name) => [name, true]),
    ...Object.keys(entry.peerDependencies ?? {})
      .filter((name) => !optionalPeers.has(name))
      .map((name) => [name, false]),
  ];
  for (const [name, optional] of edges) {
    const target = resolve(loc, name);
    if (target !== null) queue.push(target);
    else if (!optional) missingRequired.push(`${loc} -> ${name}`);
  }
}

let removed = 0;
for (const key of Object.keys(lock).sort((a, b) => b.length - a.length)) {
  if (!key.includes('node_modules/') || kept.has(key)) continue;
  const dir = path.join(root, key);
  if (!existsSync(dir)) continue;
  rmSync(dir, { recursive: true, force: true });
  removed += 1;
  // A scope folder (node_modules/@scope) left empty goes too.
  const scopeDir = path.dirname(dir);
  if (path.basename(scopeDir).startsWith('@') && readdirSync(scopeDir).length === 0) {
    rmSync(scopeDir, { recursive: true });
  }
}
// Dangling .bin links of removed packages.
for (const binDir of [path.join(root, 'node_modules/.bin')]) {
  if (!existsSync(binDir)) continue;
  for (const name of readdirSync(binDir)) {
    const file = path.join(binDir, name);
    let alive = true;
    try {
      statSync(file);
    } catch {
      alive = false;
    }
    if (!alive && lstatSync(file).isSymbolicLink()) rmSync(file);
  }
}

process.stdout.write(`prune-deps: kept ${kept.size} locations, removed ${removed} packages\n`);
if (missingRequired.length > 0) {
  process.stderr.write(
    `prune-deps: required dependency not installed:\n  ${missingRequired.join('\n  ')}\n`,
  );
  process.exit(1);
}

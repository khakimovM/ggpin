import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { DynamicModule, Type } from '@nestjs/common';
import { AdaptersModule } from '../adapters/adapters.module';
import { FragmentSessionModule } from '../adapters/fragment/fragment-session.module';
import { BankFeedModule } from '../bank-feed/bank-feed.module';
import { TopupExpireModule } from '../bank-feed/topup-expire.module';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { ReconcileModule } from '../reconcile/reconcile.module';
import { TonModule } from '../ton/ton.module';
import { roleModules, workerStartedLine } from '../worker-role-modules';

// D-76 static guard: the module closure of each role never reaches the other side, and the only
// runtime load of the MTProto library (and with it the native better-sqlite3) sits behind the
// bank-feed client provider, which only BankFeedModule registers.

/** Every module reachable through `imports` (classes and dynamic modules). */
function closure(roots: readonly Type[]): Set<unknown> {
  const seen = new Set<unknown>();
  const visit = (entry: unknown): void => {
    const module =
      typeof entry === 'object' && entry !== null && 'module' in entry
        ? (entry as DynamicModule).module
        : entry;
    if (seen.has(module)) return;
    seen.add(module);
    const imports: unknown =
      typeof module === 'function' ? Reflect.getMetadata('imports', module) : [];
    const dynamicImports =
      typeof entry === 'object' && entry !== null && 'imports' in entry
        ? ((entry as DynamicModule).imports ?? [])
        : [];
    for (const child of [
      ...(Array.isArray(imports) ? (imports as unknown[]) : []),
      ...dynamicImports,
    ])
      visit(child);
  };
  roots.forEach(visit);
  return seen;
}

const VALUE_OUT = [TonModule, AdaptersModule, FragmentSessionModule, FulfillmentModule];
const VALUE_IN = [BankFeedModule, TopupExpireModule, ReconcileModule];

describe('role module lists', () => {
  it('reaches the own modules of each side (the closure walk itself works)', () => {
    const bankfeed = closure(roleModules('bankfeed'));
    const fulfillment = closure(roleModules('fulfillment'));
    for (const module of VALUE_IN) expect(bankfeed.has(module)).toBe(true);
    for (const module of VALUE_OUT) expect(fulfillment.has(module)).toBe(true);
  });

  it('bankfeed never reaches a value-out module', () => {
    const reached = closure(roleModules('bankfeed'));
    for (const module of VALUE_OUT)
      expect([module.name, reached.has(module)]).toEqual([module.name, false]);
  });

  it('fulfillment never reaches a value-in module', () => {
    const reached = closure(roleModules('fulfillment'));
    for (const module of VALUE_IN)
      expect([module.name, reached.has(module)]).toEqual([module.name, false]);
  });

  it('all is the union of both, in one list without duplicates', () => {
    const all = roleModules('all');
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(
      new Set([...roleModules('fulfillment'), ...roleModules('bankfeed')]),
    );
  });
});

const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__' && name !== 'cli') found.push(...sources(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      found.push(path);
    }
  }
  return found;
}

/** The code without comments. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const rel = (path: string) => relative(SRC, path).split(sep).join('/');

describe('MTProto library loading (worker process, CLIs excluded)', () => {
  it('only mtcute-loader.ts loads @mtcute/node at run time, and nothing names better-sqlite3', () => {
    const loaders: string[] = [];
    for (const path of sources(SRC)) {
      const text = code(path);
      expect([rel(path), /better-sqlite3/.test(text)]).toEqual([rel(path), false]);
      const runtime = text
        .split('\n')
        .filter((line) => line.includes('@mtcute/node') && !/^\s*import type\b/.test(line));
      if (runtime.length > 0) loaders.push(rel(path));
    }
    expect(loaders).toEqual(['bank-feed/client/mtcute-loader.ts']);
  });

  it('the loader is used at run time only by the bank-feed client provider', () => {
    const users = sources(SRC)
      .filter((path) => /from '\.\/mtcute-loader'/.test(code(path)))
      .filter((path) => /import \{[^}]*\bloadMtcute\b/.test(code(path)))
      .map(rel);
    expect(users).toEqual(['bank-feed/client/bank-feed-client.provider.ts']);
  });
});

describe('boot log line by role (SA F-7)', () => {
  const facts = { FULFILLMENT_DRY_RUN: true, TON_NETWORK: 'testnet', BANK_FEED_MODE: 'off' };

  it('fulfillment shows dryRun and ton, not bankFeed', () => {
    const line = workerStartedLine({ ...facts, WORKER_ROLE: 'fulfillment' }, 11);
    expect(line).toBe(
      'worker started (role=fulfillment, consumers=price-sync,fulfill-order,validate-recipient,fragment-keepalive,reconcile, 11 queues registered, dryRun=true, ton=testnet)',
    );
  });

  it('bankfeed shows bankFeed, not dryRun or ton', () => {
    const line = workerStartedLine({ ...facts, WORKER_ROLE: 'bankfeed' }, 11);
    expect(line).toBe(
      'worker started (role=bankfeed, consumers=bank-message,card-limit,topup-expire,payment-reconcile, 11 queues registered, bankFeed=off)',
    );
  });

  it('all shows every switch', () => {
    const line = workerStartedLine({ ...facts, WORKER_ROLE: 'all' }, 11);
    expect(line).toContain('dryRun=true, ton=testnet, bankFeed=off)');
  });
});

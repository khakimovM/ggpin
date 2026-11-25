import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHttpTestApp } from '../../../../common/__tests__/create-http-test-app';
import { FxAdminService } from '../../../fx-admin/fx-admin.service';
import { OrderRetryService } from '../order-retry.service';
import { OrderReviewService } from '../order-review.service';
import { OPERATOR_CHANNEL } from '../operator-channel';

// Audit I-4 / L-3, CR i4 (plan S10 + fix round item 9): a `type: 'CLI'` resolver exists only in
// the owner CLI binary. The HTTP application (the real AppModule, infra faked) has no CLI channel,
// so the owner order and FX services cannot be built in it. The channel is one frozen object of
// operator-channel.ts compared by identity (no string or look-alike passes, see
// order-admin-rules.spec.ts); this file holds the SOURCE to the rest: across apps/api and
// apps/worker, only cli/cli-channel.ts obtains the channel, only the owner services call the
// channel checks, and only operator-channel.ts mints `type: 'CLI'`.

const API_SRC = join(__dirname, '..', '..', '..', '..');
const ROOT = join(API_SRC, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** apps/api/src and apps/worker/src, as `api/...` and `worker/...` paths. */
const FILES = [...sourceFiles(API_SRC), ...sourceFiles(join(ROOT, 'worker', 'src'))];
const rel = (path: string): string => relative(ROOT, path).split(sep).join('/');

/** The file without its comments: a comment naming `type: 'CLI'` mints nothing. */
const code = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const using = (pattern: RegExp): string[] =>
  FILES.filter((f) => pattern.test(code(f)))
    .map(rel)
    .sort();

const CHANNEL = 'api/src/modules/orders/admin/operator-channel.ts';
const OWNER_SERVICES = [
  'api/src/modules/fx-admin/fx-admin.service.ts',
  CHANNEL,
  'api/src/modules/orders/admin/order-admin-read.service.ts',
  'api/src/modules/orders/admin/order-retry.service.ts',
  'api/src/modules/orders/admin/order-review.service.ts',
  'api/src/modules/orders/admin/tx-hint.service.ts',
];

describe('I-4: the CLI channel never exists in the HTTP application', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createHttpTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('AppModule provides no OPERATOR_CHANNEL and none of the owner services', () => {
    for (const token of [OPERATOR_CHANNEL, OrderReviewService, OrderRetryService, FxAdminService]) {
      expect(() => app.get(token, { strict: false })).toThrow();
    }
  });

  it('the scan sees both apps (a broken path would make every check below pass)', () => {
    expect(FILES.some((f) => rel(f) === CHANNEL)).toBe(true);
    expect(FILES.some((f) => rel(f).startsWith('worker/src/'))).toBe(true);
  });

  it('only the CLI module graph obtains and provides the channel', () => {
    expect(using(/CLI_CHANNEL_PROVIDER/)).toEqual([
      'api/src/cli/cli-channel.ts',
      'api/src/cli/ops-cli.module.ts',
    ]);
    expect(using(/provide:\s*OPERATOR_CHANNEL/)).toEqual(['api/src/cli/cli-channel.ts']);
    expect(using(/\bcliChannelForCliModule\s*\(/)).toEqual(['api/src/cli/cli-channel.ts', CHANNEL]);
  });

  it('only the owner services call the channel checks; only operator-channel.ts mints type CLI', () => {
    expect(using(/\bcliResolver\s*\(/)).toEqual([
      CHANNEL,
      'api/src/modules/orders/admin/order-review.service.ts',
    ]);
    for (const file of using(/\bassertOwnerChannel\s*\(/)) expect(OWNER_SERVICES).toContain(file);
    expect(using(/(?<![A-Za-z])type:\s*'CLI'/)).toEqual([CHANNEL]);
  });

  it('re-review N5: only the owner repository and the order reconciler call resolveNeedsReview', () => {
    // A resolver built elsewhere (say `const type = 'CLI' as const`) still has to reach this call.
    // The second scan also catches an aliased import (`resolveNeedsReview as resolve`).
    // Phase 5 S9c (D-64 (2)): the worker's one caller is the order reconciler, and it may vouch
    // only as itself; no operator resolver (CLI or ADMIN) is ever built in the worker (I-4).
    const RECONCILER = 'worker/src/reconcile/orders/review-resolver.ts';
    const allowed = ['api/src/modules/orders/admin/order-admin.repository.ts', RECONCILER];
    expect(using(/\bresolveNeedsReview\s*\(/)).toEqual(allowed);
    expect(using(/\bresolveNeedsReview\b/)).toEqual(allowed);
    const reconciler = code(join(ROOT, RECONCILER));
    expect(reconciler.match(/\bresolveNeedsReview\s*\(/g)).toHaveLength(1);
    expect(reconciler.match(/\bresolver\s*:/g)).toHaveLength(1);
    expect(reconciler).toMatch(/\bresolver:\s*\{\s*kind:\s*'reconciler'\s*\}/);
    // CR6: the argument is one inline object literal without a spread, so no field (a resolver
    // among them) can come in from an object built elsewhere.
    const call = /\bresolveNeedsReview\s*\(([\s\S]*?)\)\s*;/.exec(reconciler)?.[1] ?? '';
    expect(call).toMatch(/^\s*tx\s*,\s*\{[\s\S]*\}\s*,?\s*$/);
    expect(call).not.toContain('...');
    expect(call).toMatch(/\bresolver:\s*\{\s*kind:\s*'reconciler'\s*\}/);
    const operatorResolver = /\bkind:\s*['"`]operator['"`]|\botpVerified\b|\bosUser\b/;
    expect(using(operatorResolver).filter((file) => file.startsWith('worker/'))).toEqual([]);
  });
});

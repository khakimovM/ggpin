import type { AdminRole } from '@repo/db';
import { AdminPricePreviewResponseSchema, CSRF_HEADER } from '@repo/shared';
import type { Res } from './admin-e2e.api';
import { useAdminE2e } from './admin-e2e.harness';
import { purgeFixtureCatalogAround } from './admin-fixture-purge';
import { buildReadWorld, type ReadWorld } from './admin-read.fixtures';
import { checkRead } from './admin-read.schemas';

const A = '/api/v1/admin';
const ALL: readonly AdminRole[] = ['OWNER', 'OPERATOR', 'SUPPORT'];
const STAFF: readonly AdminRole[] = ['OWNER', 'OPERATOR'];
const OWNER: readonly AdminRole[] = ['OWNER'];

const headerNames = (res: Res): string[] =>
  Object.keys(res.headers)
    .filter((h) => !['date', 'content-length', 'x-request-id'].includes(h))
    .sort();

/** Every S4 read route with the roles that may call it (docs/04 «Admin», D-65 D4). */
function routes(w: ReadWorld, ownerId: string): [string, readonly AdminRole[]][] {
  return [
    [`${A}/dashboard`, STAFF],
    [`${A}/users`, ALL],
    [`${A}/users/${w.user.id}`, ALL],
    [`${A}/users/${w.user.id}/orders`, ALL],
    [`${A}/users/${w.user.id}/ledger`, ALL],
    [`${A}/users/${w.user.id}/payments`, ALL],
    [`${A}/users/${w.user.id}/referrals`, ALL],
    [`${A}/users/${w.user.id}/sessions`, ALL],
    [`${A}/payments/intents`, ALL],
    [`${A}/payments`, ALL],
    [`${A}/payments/reviews`, ALL],
    [`${A}/payments/reviews/${w.reviewId}`, ALL],
    [`${A}/payments/reviews/${w.reviewId}/credit-preview?userId=${w.user.id}`, OWNER],
    [`${A}/payments/bank-messages/${w.messageId}`, ALL],
    [`${A}/payments/cards`, ALL],
    [`${A}/payments/reconcile`, ALL],
    [`${A}/audit-log`, STAFF],
    [`${A}/audit-log/export.csv?limit=1`, OWNER],
    [`${A}/admins`, OWNER],
    [`${A}/admins/${ownerId}/sessions`, OWNER],
    [`${A}/categories`, STAFF],
    [`${A}/products`, STAFF],
    [`${A}/products/${w.productId}`, STAFF],
    [`${A}/settings`, STAFF],
    [`${A}/fx/history`, STAFF],
    [`${A}/infra/queues`, STAFF],
  ];
}

// The role matrix of the read routes: a role without the permission gets exactly the 404 of a
// route that does not exist (same body, same headers); no session at all is the same 404; GET
// needs no CSRF header (only writes do).
describe('admin read routes: role matrix (real app)', () => {
  const t = useAdminE2e();
  purgeFixtureCatalogAround(t, 'ar-');
  let world: ReadWorld;
  const cookies = new Map<AdminRole, string>();
  let ownerId = '';

  beforeAll(async () => {
    world = await buildReadWorld(t.db());
    for (const role of ALL) {
      const admin = await t.newAdmin(role);
      if (role === 'OWNER') ownerId = admin.id;
      cookies.set(role, (await t.login(admin)).cookie);
    }
  });

  it('each role reaches exactly its routes; the others are the unknown-route 404', async () => {
    const unknown = await t.request(
      'GET',
      `${A}/no-such-route`,
      t.spa({ cookie: cookies.get('OWNER') ?? '' }),
    );
    expect(unknown.statusCode).toBe(404);
    for (const role of ALL) {
      const headers = t.spa({ cookie: cookies.get(role) ?? '' });
      for (const [url, roles] of routes(world, ownerId)) {
        const res = await t.request('GET', url, headers);
        if (roles.includes(role)) {
          expect([role, url, res.statusCode]).toEqual([role, url, 200]);
          // Every 200 parses with its shared schema, for every role that may read it (SA-S4-4).
          if (!url.includes('export.csv')) checkRead(url, res.statusCode, res.json());
        } else {
          expect([role, url, res.statusCode]).toEqual([role, url, 404]);
          expect(res.json()).toEqual(unknown.json());
          expect(headerNames(res)).toEqual(headerNames(unknown));
        }
      }
    }
  });

  it('no session: every read route is the same 404', async () => {
    const unknown = await t.request('GET', `${A}/no-such-route`, t.spa());
    for (const [url] of routes(world, ownerId)) {
      const res = await t.request('GET', url, t.spa());
      expect([url, res.statusCode]).toEqual([url, 404]);
      expect(res.json()).toEqual(unknown.json());
    }
  });

  it('GET needs no CSRF header (it is a write-only rule)', async () => {
    const headers = t.spa({ cookie: cookies.get('OWNER') ?? '' });
    delete headers[CSRF_HEADER];
    for (const url of [`${A}/users`, `${A}/dashboard`, `${A}/payments/cards`]) {
      expect([url, (await t.request('GET', url, headers)).statusCode]).toEqual([url, 200]);
    }
  });

  it('a malformed or unknown :id is 404 for a role that may read', async () => {
    const headers = t.spa({ cookie: cookies.get('OWNER') ?? '' });
    for (const url of [
      `${A}/users/not-an-id!`,
      `${A}/users/c${'0'.repeat(24)}`,
      `${A}/payments/reviews/c${'0'.repeat(24)}`,
      `${A}/payments/bank-messages/c${'0'.repeat(24)}`,
      `${A}/products/c${'0'.repeat(24)}`,
      `${A}/admins/c${'0'.repeat(24)}/sessions`,
      `${A}/users/c${'0'.repeat(24)}/ledger`,
    ]) {
      const res = await t.request('GET', url, headers);
      expect([url, res.statusCode]).toEqual([url, 404]);
    }
  });

  it('price preview: OPERATOR may ask, SUPPORT may not', async () => {
    const url = `${A}/products/${world.productId}/price-preview?skuId=${world.skuId}`;
    const operator = await t.request('GET', url, t.spa({ cookie: cookies.get('OPERATOR') ?? '' }));
    // The world's fresh snapshot and rate price it; exact figures: admin-read-price-preview.
    expect(operator.statusCode).toBe(200);
    AdminPricePreviewResponseSchema.parse(operator.json<{ data: unknown }>().data);
    const support = await t.request('GET', url, t.spa({ cookie: cookies.get('SUPPORT') ?? '' }));
    expect(support.statusCode).toBe(404);
  });
});

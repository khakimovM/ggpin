import { randomBytes } from 'node:crypto';
import type { AdminUser } from '@repo/db';
import { AdminAuditListResponseSchema, AUDIT_EXPORT_COLUMNS } from '@repo/shared';
import { useAdminE2e } from './admin-e2e.harness';

const A = '/api/v1/admin';
type Row = Record<string, unknown>;

// GET /admin/audit-log and its CSV export: secrets redacted for every role, IPs masked for the
// OPERATOR, the export OWNER-only, audited, bounded, rate-limited and safe to open in a sheet.
describe('admin read: audit log and CSV export (real app)', () => {
  const t = useAdminE2e();
  const targetId = `ar-${randomBytes(6).toString('hex')}`;
  const filter = `targetType=E2eRead&targetId=${targetId}`;
  let ownerAdmin: AdminUser;
  let owner = '';
  let operator = '';
  let support = '';

  beforeAll(async () => {
    ownerAdmin = await t.newAdmin('OWNER');
    owner = (await t.login(ownerAdmin)).cookie;
    operator = (await t.login(await t.newAdmin('OPERATOR'))).cookie;
    support = (await t.login(await t.newAdmin('SUPPORT'))).cookie;
    const base = { targetType: 'E2eRead', targetId, action: 'USER_NOTE' };
    const db = t.db();
    await db.auditLog.create({
      data: {
        ...base,
        actorType: 'ADMIN',
        actorId: ownerAdmin.id,
        ip: '198.51.100.23',
        reason: '+cmd|calc',
        after: { otp: '123456', ip: '203.0.113.77', note: 'hello', amountTiyin: '5' },
        createdAt: new Date(Date.now() - 3000),
      },
    });
    await db.auditLog.create({
      data: {
        ...base,
        actorType: 'CLI',
        actorId: null,
        after: { operator: '=1+1' },
        createdAt: new Date(Date.now() - 2000),
      },
    });
    await db.auditLog.create({
      data: { ...base, actorType: 'SYSTEM', actorId: null, createdAt: new Date(Date.now() - 1000) },
    });
  });

  const get = (url: string, cookie: string) => t.request('GET', url, t.spa({ cookie }));
  const rows = (body: { data: unknown }): Row[] =>
    Array.isArray(body.data) ? (body.data as Row[]) : [];

  it('OWNER: newest first, actor names, secrets redacted, IPs in full', async () => {
    const res = await get(`${A}/audit-log?${filter}`, owner);
    expect(res.statusCode).toBe(200);
    const list = rows(res.json());
    AdminAuditListResponseSchema.parse(res.json<{ data: unknown }>().data);
    expect(list.map((row) => (row['actor'] as Row)['type'])).toEqual(['SYSTEM', 'CLI', 'ADMIN']);
    const admin = list[2] ?? {};
    expect(admin['actor']).toEqual({ type: 'ADMIN', id: ownerAdmin.id, name: ownerAdmin.name });
    expect((list[1]?.['actor'] as Row)['name']).toBe('=1+1');
    expect(admin['ip']).toBe('198.51.100.23');
    expect(admin['after']).toMatchObject({ otp: '[redacted]', ip: '203.0.113.77', note: 'hello' });
    expect(res.body).not.toContain('123456');
  });

  it('OPERATOR: IPs masked (row and JSON); SUPPORT: 404', async () => {
    const res = await get(`${A}/audit-log?${filter}`, operator);
    expect(res.statusCode).toBe(200);
    AdminAuditListResponseSchema.parse(res.json<{ data: unknown }>().data);
    const admin = rows(res.json())[2] ?? {};
    expect(admin['ip']).toBe('198.51.100.x');
    expect(res.body).not.toContain('203.0.113.77');
    expect(res.body).not.toContain('198.51.100.23');
    expect(res.body).not.toContain('123456');
    expect((await get(`${A}/audit-log?${filter}`, support)).statusCode).toBe(404);
    expect((await get(`${A}/audit-log?limit=101`, operator)).statusCode).toBe(400);
  });

  it('export: a CSV attachment, formula cells neutralised, secrets redacted, audited', async () => {
    const before = await t.db().auditLog.count({
      where: { action: 'AUDIT_EXPORT', actorId: ownerAdmin.id },
    });
    const res = await get(`${A}/audit-log/export.csv?${filter}`, owner);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment;/);
    const lines = res.body.split('\r\n').filter((line) => line !== '');
    expect(lines[0]).toBe(AUDIT_EXPORT_COLUMNS.map((column) => `"${column}"`).join(','));
    expect(lines).toHaveLength(4);
    expect(res.body).toContain(`"'+cmd|calc"`);
    expect(res.body).toContain(`"'=1+1"`);
    expect(res.body).not.toMatch(/(^|,)"[=+\-@]/m);
    expect(res.body).not.toContain('123456');
    const after = await t.db().auditLog.findMany({
      where: { action: 'AUDIT_EXPORT', actorId: ownerAdmin.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(after).toHaveLength(before + 1);
    expect(after[0]).toMatchObject({ actorType: 'ADMIN', targetType: 'AuditLog' });
    expect(after[0]?.after).toMatchObject({ targetId, limit: 10_000, adminRole: 'OWNER' });
  });

  it('export: limit bounds the rows; 0 and 10 001 are 400; OPERATOR gets 404', async () => {
    const two = await get(`${A}/audit-log/export.csv?${filter}&limit=2`, owner);
    expect(two.body.split('\r\n').filter((line) => line !== '')).toHaveLength(3);
    for (const bad of ['limit=0', 'limit=10001', 'page=1']) {
      expect([bad, (await get(`${A}/audit-log/export.csv?${bad}`, owner)).statusCode]).toEqual([
        bad,
        400,
      ]);
    }
    expect((await get(`${A}/audit-log/export.csv?${filter}`, operator)).statusCode).toBe(404);
  });

  it('export: 5 a minute per session, the 6th is 429', async () => {
    const fresh = (await t.login(await t.newAdmin('OWNER'))).cookie;
    for (let i = 0; i < 5; i += 1) {
      expect((await get(`${A}/audit-log/export.csv?${filter}&limit=1`, fresh)).statusCode).toBe(
        200,
      );
    }
    const sixth = await get(`${A}/audit-log/export.csv?${filter}&limit=1`, fresh);
    expect(sixth.statusCode).toBe(429);
    // The list is not counted against the export budget.
    expect((await get(`${A}/audit-log?${filter}`, fresh)).statusCode).toBe(200);
  });
});

import { randomBytes } from 'node:crypto';
import type { AdminUser } from '@repo/db';
import { AdminAuditListResponseSchema } from '@repo/shared';
import { maskTelegramId } from '../admins/admin-allowlist';
import { useAdminE2e } from './admin-e2e.harness';

const A = '/api/v1/admin';
type Row = Record<string, unknown>;
const ADMIN_TG = 7_012_345_678_901_234n;

// SA-S4-3 (variant a): who an admin is outside the panel (the Telegram id, the CLI's OS user)
// is the OWNER's to see; OPERATOR reads the same audit rows with the id masked and `osUser`
// null. SA-S4-6: a HEAD of the CSV export neither exports nor writes an audit row.
describe('admin read: admin identity in audit JSON, HEAD export (real app)', () => {
  const t = useAdminE2e();
  const targetId = `ai-${randomBytes(6).toString('hex')}`;
  const filter = `targetType=E2eIdentity&targetId=${targetId}`;
  let ownerAdmin: AdminUser;
  let owner = '';
  let operator = '';

  beforeAll(async () => {
    ownerAdmin = await t.newAdmin('OWNER');
    owner = (await t.login(ownerAdmin)).cookie;
    operator = (await t.login(await t.newAdmin('OPERATOR'))).cookie;
    const base = { targetType: 'E2eIdentity', targetId };
    // The shapes AdminAccountsService (CLI `admin add`) and a login-side row write.
    await t.db().auditLog.create({
      data: {
        ...base,
        action: 'ADMIN_CREATE',
        actorType: 'CLI',
        actorId: null,
        after: {
          telegramId: ADMIN_TG.toString(),
          name: 'Ops',
          role: 'OPERATOR',
          operator: 'aziz',
          osUser: 'deploy',
        },
        createdAt: new Date(Date.now() - 2000),
      },
    });
    await t.db().auditLog.create({
      data: {
        ...base,
        action: 'ADMIN_LOGIN',
        actorType: 'ADMIN',
        actorId: ownerAdmin.id,
        after: { role: 'OWNER', adminTelegramId: ADMIN_TG.toString(), ipMasked: '10.0.0.x' },
        createdAt: new Date(Date.now() - 1000),
      },
    });
  });

  const list = async (cookie: string) => {
    const res = await t.request('GET', `${A}/audit-log?${filter}`, t.spa({ cookie }));
    expect(res.statusCode).toBe(200);
    const data = AdminAuditListResponseSchema.parse(res.json<{ data: unknown }>().data);
    const byAction = new Map(data.map((row) => [row.action, row.after as Row]));
    return {
      body: res.body,
      create: byAction.get('ADMIN_CREATE'),
      login: byAction.get('ADMIN_LOGIN'),
    };
  };

  it('OPERATOR: the Telegram id masked, osUser null, keys kept', async () => {
    const { body, create, login } = await list(operator);
    const masked = maskTelegramId(ADMIN_TG);
    expect(create).toEqual({
      telegramId: masked,
      name: 'Ops',
      role: 'OPERATOR',
      operator: 'aziz',
      osUser: null,
    });
    expect(login).toMatchObject({ adminTelegramId: masked });
    expect(body).not.toContain(ADMIN_TG.toString());
    expect(body).not.toContain('deploy');
  });

  it('OWNER: as written', async () => {
    const { create, login } = await list(owner);
    expect(create).toMatchObject({ telegramId: ADMIN_TG.toString(), osUser: 'deploy' });
    expect(login).toMatchObject({ adminTelegramId: ADMIN_TG.toString() });
  });

  it('HEAD export.csv: 404, no export row, the export budget untouched', async () => {
    const where = { action: 'AUDIT_EXPORT', actorId: ownerAdmin.id } as const;
    const before = await t.db().auditLog.count({ where });
    const url = `${A}/audit-log/export.csv?${filter}`;
    const head = await t.request('HEAD', url, t.spa({ cookie: owner }));
    expect(head.statusCode).toBe(404);
    expect(head.headers['content-disposition']).toBeUndefined();
    expect(await t.db().auditLog.count({ where })).toBe(before);
    // Five real exports still fit in the minute: the HEAD was not counted.
    for (let i = 0; i < 5; i += 1) {
      const res = await t.request('GET', `${url}&limit=1`, t.spa({ cookie: owner }));
      expect(res.statusCode).toBe(200);
    }
    expect(await t.db().auditLog.count({ where })).toBe(before + 5);
  });
});

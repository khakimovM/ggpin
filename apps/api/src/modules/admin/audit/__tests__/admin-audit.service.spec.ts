import type { AdminUser } from '@repo/db';
import { AUDIT_EXPORT_COLUMNS } from '@repo/shared';
import type { AdminPrincipal } from '../../common/admin-request';
import type { AdminThrottle } from '../../common/admin-throttle';
import { AdminAuditService } from '../admin-audit.service';
import type { AdminAuditRepository, AuditRowSource } from '../admin-audit.repository';

const row = (i: number, over: Partial<AuditRowSource> = {}): AuditRowSource => ({
  id: `cm${String(i).padStart(23, '0')}`,
  createdAt: new Date(Date.UTC(2026, 10, 17, 0, 0, 1000 - i)),
  actorType: 'ADMIN',
  actorId: 'admin1',
  action: 'USER_NOTE',
  targetType: 'User',
  targetId: 'u1',
  before: null,
  after: { otp: '123456', ip: '203.0.113.77' },
  reason: null,
  ip: '198.51.100.23',
  ...over,
});

function service(rows: AuditRowSource[]) {
  const calls: { cursor: unknown; take: number }[] = [];
  const recorded: unknown[] = [];
  const repo = {
    exportBatch: (_f: unknown, cursor: { id: string } | null, take: number) => {
      calls.push({ cursor, take });
      const start = cursor === null ? 0 : rows.findIndex((r) => r.id === cursor.id) + 1;
      return Promise.resolve(rows.slice(start, start + take));
    },
    adminNames: () => Promise.resolve(new Map([['admin1', '=HYPERLINK("x")']])),
    recordExport: (record: unknown) => {
      recorded.push(record);
      return Promise.resolve('audit1');
    },
  } as unknown as AdminAuditRepository;
  const counted: string[] = [];
  const throttle = {
    countExport: (sessionId: string) => {
      counted.push(sessionId);
      return Promise.resolve();
    },
  } as unknown as AdminThrottle;
  return { svc: new AdminAuditService(repo, throttle), calls, recorded, counted };
}

const principal = (role: AdminUser['role']): AdminPrincipal =>
  ({ sessionId: 's1', admin: { id: 'admin1', role } }) as unknown as AdminPrincipal;

async function read(stream: NodeJS.ReadableStream): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += String(chunk);
  return text;
}

describe('AdminAuditService.export', () => {
  it('counts the session, records the export first, then streams header + rows (CRLF)', async () => {
    const { svc, recorded, counted } = service([row(1), row(2)]);
    const csv = await read(await svc.export(principal('OWNER'), '10.0.0.1', { limit: 10_000 }));
    expect(counted).toEqual(['s1']);
    expect(recorded).toEqual([
      { adminId: 'admin1', adminRole: 'OWNER', ip: '10.0.0.1', filters: { limit: 10_000 } },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(AUDIT_EXPORT_COLUMNS.map((column) => `"${column}"`).join(','));
    expect(lines).toHaveLength(4); // header, two rows, trailing empty
  });

  it('neutralises formula cells and never writes a secret', async () => {
    const { svc } = service([row(1, { reason: '-2+3', targetId: '@SUM(A1)' })]);
    const csv = await read(await svc.export(principal('OWNER'), '10.0.0.1', { limit: 10 }));
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`"'-2+3"`);
    expect(csv).toContain(`"'@SUM(A1)"`);
    expect(csv).not.toMatch(/(^|,)"[=+\-@]/m);
    expect(csv).not.toContain('123456');
  });

  it('pages by keyset in batches and stops at the limit', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => row(i));
    const { svc, calls } = service(rows);
    const csv = await read(await svc.export(principal('OWNER'), '10.0.0.1', { limit: 1001 }));
    expect(csv.split('\r\n').filter((l) => l !== '')).toHaveLength(1002);
    expect(calls.map((c) => c.take)).toEqual([500, 500, 1]);
    expect(calls[1]?.cursor).toMatchObject({ id: rows[499]?.id });
  });
});

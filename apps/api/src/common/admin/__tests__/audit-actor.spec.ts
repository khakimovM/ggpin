import { AppError } from '../../exceptions/app-error';
import {
  actorOfInput,
  auditIdOf,
  checkedAuditActor,
  toAuditColumns,
  type AdminActor,
} from '../audit-actor';
import { OPEN_DEADLINE } from './admin-deadline.fixture';

// Who wrote an AuditLog row (phase 9 S6): the CLI keeps its old columns (the repositories add
// actorType=CLI), an admin is ADMIN + its id, and the panel's audit id comes from the request key.
const ADMIN: AdminActor = {
  kind: 'ADMIN',
  adminId: 'adm1',
  sessionId: 'ses1',
  ip: '203.0.113.7',
  permission: 'users.block',
  request: { auditId: 'a'.repeat(32), requestHash: 'h' },
  deadline: OPEN_DEADLINE,
};

function details(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.details : error;
  }
  return undefined;
}

describe('audit actor', () => {
  it('a service input names exactly one actor: the CLI fields or `actor`', () => {
    expect(actorOfInput({ operator: 'aziz', ip: '203.0.113.9' })).toEqual({
      operator: 'aziz',
      ip: '203.0.113.9',
      osUser: null,
    });
    expect(actorOfInput({ actor: ADMIN })).toBe(ADMIN);
    expect(details(() => actorOfInput({}))).toEqual({ field: 'operator' });
    expect(details(() => actorOfInput({ actor: ADMIN, operator: 'aziz' }))).toEqual({
      field: 'operator',
    });
  });

  it('columns: ADMIN with its id; the CLI only its address (unchanged rows, p4 tests)', () => {
    expect(toAuditColumns(ADMIN)).toEqual({
      actorType: 'ADMIN',
      actorId: 'adm1',
      ip: '203.0.113.7',
    });
    const cli = checkedAuditActor({ operator: 'aziz', ip: '203.0.113.9' });
    expect(toAuditColumns(cli)).toEqual({ ip: '203.0.113.9' });
  });

  it('the audit id: the request key for an admin, the CLI its own (or none)', () => {
    expect(auditIdOf(ADMIN, 'cli-id')).toBe(ADMIN.request.auditId);
    const cli = checkedAuditActor({ operator: 'aziz' });
    expect(auditIdOf(cli, 'cli-id')).toBe('cli-id');
    expect(auditIdOf(cli)).toBeUndefined();
  });
});

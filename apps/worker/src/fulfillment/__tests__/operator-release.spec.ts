import { $Enums, type Prisma } from '@repo/db';
import { ORDER_RETRY_ACTOR_ROLES } from '@repo/shared';
import {
  clampRelease,
  isOwnerRelease,
  releasedAfterOf,
  type ReleaseRow,
} from '../operator-release.repository';

// Which ORDER_RETRY row restarts the attempt count, and with which number (phase 5 S9b, D-66 (2),
// plan §12-§13). Every doubt counts every attempt (null).

const row = (over: Partial<ReleaseRow>): ReleaseRow => ({
  actorType: 'CLI',
  before: { status: 'HELD', maxAttemptNo: 2 },
  after: { status: 'QUEUED', actor: { type: 'CLI', role: 'OWNER' } },
  ...over,
});
const attempts = (...numbers: number[]) => numbers.map((attemptNo) => ({ attemptNo, error: null }));

describe('ORDER_RETRY_ACTOR_ROLES', () => {
  it('are exactly the Prisma AdminRole values (a new role must be decided here, not dropped)', () => {
    expect(Object.values($Enums.AdminRole).sort()).toEqual([...ORDER_RETRY_ACTOR_ROLES].sort());
  });
});

describe('isOwnerRelease', () => {
  it('the CLI owner channel counts, with or without the actor block (rows before S9b)', () => {
    expect(isOwnerRelease(row({}))).toBe(true);
    expect(isOwnerRelease(row({ after: { status: 'QUEUED' } }))).toBe(true);
  });

  it('the panel counts only for the OWNER role with an ADMIN actor', () => {
    const admin = (role: Prisma.JsonValue | undefined, type: Prisma.JsonValue = 'ADMIN') =>
      row({ actorType: 'ADMIN', after: { status: 'QUEUED', actor: { type, role } } });
    expect(isOwnerRelease(admin('OWNER'))).toBe(true);
    for (const role of ['OPERATOR', 'SUPPORT', 'owner', '', null, undefined, 1]) {
      expect(isOwnerRelease(admin(role))).toBe(false);
    }
    expect(isOwnerRelease(row({ actorType: 'ADMIN', after: null }))).toBe(false);
    expect(isOwnerRelease(row({ actorType: 'ADMIN', after: ['OWNER'] }))).toBe(false);
    expect(isOwnerRelease(row({ actorType: 'ADMIN', after: { actor: { role: 'OWNER' } } }))).toBe(
      false,
    );
  });

  it('CR L2: an ADMIN row whose actor claims the CLI (or anything but ADMIN) is not the owner', () => {
    for (const type of ['CLI', 'SYSTEM', 'admin', null]) {
      const mixed = row({ actorType: 'ADMIN', after: { actor: { type, role: 'OWNER' } } });
      expect(isOwnerRelease(mixed)).toBe(false);
    }
  });

  it('SYSTEM or any other actor never counts, whatever its after says', () => {
    for (const actorType of ['SYSTEM', 'BOT', 'cli', '']) {
      expect(isOwnerRelease(row({ actorType }))).toBe(false);
    }
  });
});

describe('releasedAfterOf', () => {
  it('a whole number >= 0', () => {
    expect(releasedAfterOf(row({ before: { maxAttemptNo: 0 } }))).toBe(0);
    expect(releasedAfterOf(row({ before: { maxAttemptNo: 3 } }))).toBe(3);
  });

  it.each([
    ['missing', { status: 'HELD' }],
    ['negative', { maxAttemptNo: -1 }],
    ['a fraction', { maxAttemptNo: 1.5 }],
    ['a string', { maxAttemptNo: '2' }],
    ['null', { maxAttemptNo: null }],
    ['NaN-like', { maxAttemptNo: Number.NaN }],
  ])('%s -> null (count every attempt)', (_name, before) => {
    expect(releasedAfterOf(row({ before }))).toBeNull();
  });

  it('no before at all -> null', () => {
    expect(releasedAfterOf(row({ before: null }))).toBeNull();
    expect(releasedAfterOf(row({ before: [2] }))).toBeNull();
  });
});

describe('clampRelease (§13)', () => {
  it('a number within the order’s attempts is kept', () => {
    expect(clampRelease(2, attempts(1, 2))).toBe(2);
    expect(clampRelease(2, attempts(1, 2, 3))).toBe(2);
    expect(clampRelease(0, attempts())).toBe(0);
  });

  it('a number above the highest attempt is a corrupt row: null', () => {
    expect(clampRelease(3, attempts(1, 2))).toBeNull();
    expect(clampRelease(1_000_000_000, attempts(1, 2))).toBeNull();
    expect(clampRelease(1, attempts())).toBeNull();
  });

  it('null stays null', () => {
    expect(clampRelease(null, attempts(1, 2))).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { expectCheck } from './check-helpers';
import { db } from './client';
import { createUser, loginRequestData } from './factories';

const create = (overrides: Parameters<typeof loginRequestData>[0] = {}) =>
  db.loginRequest.create({ data: loginRequestData(overrides) });

describe('LoginRequest CHECK constraints', () => {
  it('attempts: 0 and 5 are accepted, -1 and 6 are rejected', async () => {
    await create({ attempts: 0 });
    await create({ attempts: 5 });
    await expectCheck(create({ attempts: -1 }), 'LoginRequest_attempts_check');
    await expectCheck(create({ attempts: 6 }), 'LoginRequest_attempts_check');
  });

  it('attempts: an increment past the limit is rejected on update too', async () => {
    const row = await create({ attempts: 5 });
    await expectCheck(
      db.loginRequest.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } }),
      'LoginRequest_attempts_check',
    );
  });

  it('kind: USER and ADMIN are accepted, anything else is rejected', async () => {
    await create({ kind: 'USER' });
    await create({ kind: 'ADMIN' });
    await expectCheck(create({ kind: 'user' }), 'LoginRequest_kind_check');
    await expectCheck(create({ kind: 'OPERATOR' }), 'LoginRequest_kind_check');
  });

  it('status: every known value is accepted, an unknown one is rejected', async () => {
    for (const status of ['PENDING', 'EXPIRED', 'DENIED', 'USED']) {
      await create({ status });
    }
    await expectCheck(create({ status: 'DONE' }), 'LoginRequest_status_check');
    await expectCheck(create({ status: 'pending' }), 'LoginRequest_status_check');
  });

  it('CODE_SENT needs codeHash and telegramId', async () => {
    const both = { status: 'CODE_SENT', codeHash: 'a'.repeat(64), telegramId: 777n };
    const sent = await create(both);
    expect(sent.status).toBe('CODE_SENT');

    await expectCheck(
      create({ status: 'CODE_SENT', telegramId: 777n }),
      'LoginRequest_code_sent_check',
    );
    await expectCheck(
      create({ status: 'CODE_SENT', codeHash: 'a'.repeat(64) }),
      'LoginRequest_code_sent_check',
    );
    await expectCheck(create({ status: 'CODE_SENT' }), 'LoginRequest_code_sent_check');
  });

  it('CODE_SENT cannot be reached by an update that leaves the hash empty', async () => {
    const pending = await create({});
    await expectCheck(
      db.loginRequest.update({ where: { id: pending.id }, data: { status: 'CODE_SENT' } }),
      'LoginRequest_code_sent_check',
    );
    const sent = await db.loginRequest.update({
      where: { id: pending.id },
      data: { status: 'CODE_SENT', codeHash: 'b'.repeat(64), telegramId: 888n },
    });
    expect(sent.status).toBe('CODE_SENT');
  });
});

describe('User.botBlockedAt', () => {
  it('is null by default and round-trips independently of isBlocked', async () => {
    const user = await createUser();
    expect(user.botBlockedAt).toBeNull();

    const at = new Date('2026-11-02T10:00:00.000Z');
    await db.user.update({ where: { id: user.id }, data: { botBlockedAt: at } });
    const blocked = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(blocked.botBlockedAt?.toISOString()).toBe(at.toISOString());
    expect(blocked.isBlocked).toBe(false);

    await db.user.update({ where: { id: user.id }, data: { botBlockedAt: null } });
    const cleared = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(cleared.botBlockedAt).toBeNull();
  });
});

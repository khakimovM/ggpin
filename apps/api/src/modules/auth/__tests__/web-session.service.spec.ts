import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { REFRESH_TOKEN_TTL_SEC } from '@repo/shared';
import { AppError } from '../../../common/exceptions/app-error';
import {
  TEST_JWT_ACCESS_SECRET,
  TEST_JWT_REFRESH_SECRET,
  TEST_TG_SESSION_SECRET,
} from '../../../config/__tests__/test-env';
import type { UsersService } from '../../users/users.service';
import { TokenCodec } from '../token-codec';
import type { RefreshRowState, WebSessionRepository } from '../web-session.repository';
import { WebSessionService } from '../web-session.service';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const TOKEN = 'A'.repeat(43);
const hashOf = (token: string): string =>
  createHmac('sha256', TEST_JWT_REFRESH_SECRET).update(token).digest('hex');

function setup(
  rows: {
    live?: { userId: string; familyId: string } | null;
    state?: RefreshRowState | null;
  },
  users: Partial<Record<'findByTelegramId' | 'findById', jest.Mock>> = {},
) {
  const repo = {
    transaction: jest.fn(<T>(fn: (tx: unknown) => Promise<T>) => fn({})),
    revokeLiveByHash: jest.fn(() => Promise.resolve(rows.live ?? null)),
    insert: jest.fn(() => Promise.resolve()),
    findByHash: jest.fn(() => Promise.resolve(rows.state ?? null)),
    revokeFamily: jest.fn(() => Promise.resolve(1)),
    isFamilyActive: jest.fn(() => Promise.resolve(true)),
  };
  const codec = new TokenCodec({
    JWT_ACCESS_SECRET: TEST_JWT_ACCESS_SECRET,
    TG_SESSION_SECRET: TEST_TG_SESSION_SECRET,
  });
  const service = new WebSessionService(
    repo as unknown as WebSessionRepository,
    users as unknown as UsersService,
    codec,
    { JWT_REFRESH_SECRET: TEST_JWT_REFRESH_SECRET },
  );
  return { repo, service };
}

const state = (over: Partial<RefreshRowState>): RefreshRowState => ({
  userId: 'u1',
  familyId: 'f1',
  revokedAt: null,
  ...over,
});

describe('WebSessionService.rotate', () => {
  it('rotates a live token: looks it up by keyed hash, inserts the next row in the same family', async () => {
    const { repo, service } = setup({ live: { userId: 'u1', familyId: 'f1' } });
    const next = await service.rotate(TOKEN, { userAgent: 'UA', ip: '203.0.113.45' }, NOW);
    expect(repo.revokeLiveByHash).toHaveBeenCalledWith(hashOf(TOKEN), NOW, expect.anything());
    expect(next).toMatchObject({ userId: 'u1', familyId: 'f1' });
    expect(next.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(next.refreshToken).not.toBe(TOKEN);
    expect(repo.insert).toHaveBeenCalledTimes(1);
    const [row] = repo.insert.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(row).toMatchObject({
      userId: 'u1',
      familyId: 'f1',
      ip: '203.0.113.x',
      userAgent: 'UA',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + REFRESH_TOKEN_TTL_SEC * 1000),
    });
    expect(row['refreshHash']).toBe(hashOf(next.refreshToken));
    expect(row['refreshHash']).not.toBe(next.refreshToken); // only the hash is stored
  });

  it('a malformed token never reaches the repository', async () => {
    const { repo, service } = setup({});
    for (const bad of ['', 'short', 'A'.repeat(44), `${'A'.repeat(42)}!`]) {
      await expect(service.rotate(bad, {}, NOW)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    expect(repo.transaction).not.toHaveBeenCalled();
  });

  it('unknown token -> UNAUTHORIZED, nothing revoked', async () => {
    const { repo, service } = setup({ state: null });
    await expect(service.rotate(TOKEN, {}, NOW)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(repo.revokeFamily).not.toHaveBeenCalled();
  });

  it('an already revoked (rotated) token -> TOKEN_REUSE_DETECTED and the family is revoked', async () => {
    const { repo, service } = setup({ state: state({ revokedAt: NOW }) });
    const error: unknown = await service.rotate(TOKEN, {}, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'TOKEN_REUSE_DETECTED' });
    expect(repo.revokeFamily).toHaveBeenCalledWith({ familyId: 'f1', userId: 'u1', now: NOW });
  });

  it('a never-retired token that is not live (expired) -> UNAUTHORIZED, not theft, family tidied up', async () => {
    const { repo, service } = setup({ state: state({}) });
    await expect(service.rotate(TOKEN, {}, NOW)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(repo.revokeFamily).toHaveBeenCalledWith({ familyId: 'f1', userId: 'u1', now: NOW });
  });
});

describe('WebSessionService.revokeFamily', () => {
  it('is a NOT_FOUND when nothing of the caller matched (someone else, or already gone)', async () => {
    const { repo, service } = setup({});
    repo.revokeFamily.mockResolvedValueOnce(0);
    await expect(
      service.revokeFamily({ userId: 'me', familyId: 'theirs', now: NOW }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(repo.revokeFamily).toHaveBeenCalledWith({ userId: 'me', familyId: 'theirs', now: NOW });
  });
});

describe('WebSessionService security events', () => {
  it('TOKEN_REUSE_DETECTED is logged as a warn with user and family ids only', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { service } = setup({ state: state({ revokedAt: NOW }) });
      await expect(service.rotate(TOKEN, { ip: '203.0.113.45' }, NOW)).rejects.toMatchObject({
        code: 'TOKEN_REUSE_DETECTED',
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toBe('security event=TOKEN_REUSE_DETECTED userId=u1 familyId=f1');
      expect(line).not.toContain(TOKEN);
    } finally {
      warn.mockRestore();
    }
  });

  it('a merely expired token is not reported as reuse', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { service } = setup({ state: state({}) });
      await expect(service.rotate(TOKEN, {}, NOW)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('WebSessionService.isFamilyActive', () => {
  it('asks the repository with the user and the family together', async () => {
    const { repo, service } = setup({});
    await expect(service.isFamilyActive({ userId: 'u1', familyId: 'f1' }, NOW)).resolves.toBe(true);
    expect(repo.isFamilyActive).toHaveBeenCalledWith({ userId: 'u1', familyId: 'f1' }, NOW);
  });
});

describe('WebSessionService.endSessionFromBot', () => {
  const input = { telegramId: 555n, familyId: 'f1', now: NOW };

  it('revokes the family of the user that owns the telegram id, scoped by that user', async () => {
    const { repo, service } = setup(
      {},
      { findByTelegramId: jest.fn().mockResolvedValue({ id: 'u1' }) },
    );
    await expect(service.endSessionFromBot(input)).resolves.toBe(true);
    expect(repo.revokeFamily).toHaveBeenCalledWith({ userId: 'u1', familyId: 'f1', now: NOW });
  });

  it('is false (and does not throw) for a family that is not theirs or already ended', async () => {
    const { repo, service } = setup(
      {},
      { findByTelegramId: jest.fn().mockResolvedValue({ id: 'u1' }) },
    );
    repo.revokeFamily.mockResolvedValueOnce(0);
    await expect(service.endSessionFromBot(input)).resolves.toBe(false);
  });

  it('is false for an unknown telegram id, without touching any session', async () => {
    const { repo, service } = setup({}, { findByTelegramId: jest.fn().mockResolvedValue(null) });
    await expect(service.endSessionFromBot(input)).resolves.toBe(false);
    expect(repo.revokeFamily).not.toHaveBeenCalled();
  });
});

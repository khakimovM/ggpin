import type { User } from '@repo/db';
import { AppError } from '../../../common/exceptions/app-error';
import type { UsersRepository } from '../users.repository';
import { UsersService } from '../users.service';

function service(repo: Partial<Record<keyof UsersRepository, jest.Mock>>): UsersService {
  return new UsersService(repo as unknown as UsersRepository);
}

describe('UsersService (mocked repository)', () => {
  it('getMe: unknown user -> NOT_FOUND', async () => {
    const svc = service({ findById: jest.fn().mockResolvedValue(null) });
    await expect(svc.getMe('missing')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(svc.getMe('missing')).rejects.toBeInstanceOf(AppError);
  });

  it('updateLocale: unknown user -> NOT_FOUND', async () => {
    const svc = service({ updateLocale: jest.fn().mockResolvedValue(null) });
    await expect(svc.updateLocale('missing', 'ru')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('findActiveById passes the repository result through', async () => {
    const row = { id: 'u1' } as User;
    const svc = service({ findById: jest.fn().mockResolvedValue(row) });
    await expect(svc.findActiveById('u1')).resolves.toBe(row);
  });

  it('markBotBlocked / clearBotBlocked delegate with the timestamp or null', async () => {
    const setBotBlockedAt = jest.fn().mockResolvedValue(undefined);
    const svc = service({ setBotBlockedAt });
    const at = new Date('2026-01-01T00:00:00.000Z');
    await svc.markBotBlocked(5n, at);
    await svc.clearBotBlocked(5n);
    expect(setBotBlockedAt).toHaveBeenNthCalledWith(1, 5n, at);
    expect(setBotBlockedAt).toHaveBeenNthCalledWith(2, 5n, null);
  });
});

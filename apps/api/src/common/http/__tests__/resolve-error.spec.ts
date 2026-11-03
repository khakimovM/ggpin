import { ForbiddenException, HttpException } from '@nestjs/common';
import { AppError } from '../../exceptions/app-error';
import { resolveError } from '../resolve-error';

describe('resolveError: 403 handling (D-26)', () => {
  it('a generic ForbiddenException becomes NOT_FOUND and is not logged as a server fault', () => {
    expect(resolveError(new ForbiddenException('role missing'))).toEqual({
      code: 'NOT_FOUND',
      log: false,
    });
  });

  it('a bare HttpException with status 403 is treated the same', () => {
    expect(resolveError(new HttpException('nope', 403))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not carry the original message into the result', () => {
    expect(JSON.stringify(resolveError(new ForbiddenException('role missing')))).not.toContain(
      'role missing',
    );
  });

  it.each(['USER_BLOCKED', 'PURCHASE_FROZEN'] as const)(
    'AppError %s keeps its own code (and its 403 status)',
    (code) => {
      const error = new AppError(code);
      expect(error.status).toBe(403);
      expect(resolveError(error)).toMatchObject({ code, log: false });
    },
  );

  it('an unmapped status is still INTERNAL_ERROR and logged', () => {
    expect(resolveError(new HttpException('teapot', 418))).toEqual({
      code: 'INTERNAL_ERROR',
      log: true,
    });
  });
});

import { buildTestEnv } from '../../../config/__tests__/test-env';
import { corsOrigins } from '../cors-origins';

describe('corsOrigins', () => {
  it('is exactly WEB_URL and ADMIN_URL by default', () => {
    expect(corsOrigins(buildTestEnv())).toEqual(['http://localhost:3000', 'http://localhost:5173']);
  });

  it('adds nothing when the Mini App lives on the web origin', () => {
    const env = buildTestEnv({ MINI_APP_URL: 'http://localhost:3000/tg' });
    expect(corsOrigins(env)).toEqual(['http://localhost:3000', 'http://localhost:5173']);
  });

  it('adds only the origin (no path) of a distinct Mini App URL', () => {
    const env = buildTestEnv({ MINI_APP_URL: 'https://miniapp.example.uz/tg?x=1' });
    expect(corsOrigins(env)).toEqual([
      'http://localhost:3000',
      'http://localhost:5173',
      'https://miniapp.example.uz',
    ]);
  });
});

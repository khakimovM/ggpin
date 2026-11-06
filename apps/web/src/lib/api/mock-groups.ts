import { env } from '../../env';
import type { MockGroupName } from '../../env-schema';

export { MOCK_GROUP_NAMES, type MockGroupName } from '../../env-schema';

export interface MockSource {
  production: boolean;
  groups: readonly MockGroupName[];
}

/**
 * Pure decision, separate from the environment so a test can exercise the production branch.
 * Production never mocks, whatever the list says: a mocked wallet would show money that does
 * not exist. (The build also refuses a non-empty list in production, see env-schema.)
 */
export function isMockedWith(group: MockGroupName | undefined, source: MockSource): boolean {
  if (group === undefined || source.production) return false;
  return source.groups.includes(group);
}

export function isMocked(group: MockGroupName | undefined): boolean {
  return isMockedWith(group, {
    production: process.env.NODE_ENV === 'production',
    groups: env.NEXT_PUBLIC_API_MOCKS,
  });
}

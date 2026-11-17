import type { MockGroupName } from '../../env-schema';

export interface MockSource {
  production: boolean;
  groups: readonly MockGroupName[];
}

/**
 * Pure decision, separate from the environment so a test can exercise the production branch.
 * Production never mocks, whatever the list says (the build refuses a non-empty list as well).
 */
export function isMockedWith(group: MockGroupName | undefined, source: MockSource): boolean {
  if (group === undefined || source.production) return false;
  return source.groups.includes(group);
}

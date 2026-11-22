// State of the dev mock "server", kept in sessionStorage so a reload keeps the mock session (as a
// cookie would) and a Playwright test can start signed in, as a given role, or with a failing
// login, by writing the key before the page loads (page.addInitScript).
import { AdminRoleSchema, type AdminRole } from '@repo/shared';
import { z } from 'zod';

export const MOCK_STATE_KEY = 'ggpin-admin-mock';

const stateSchema = z.object({
  signedIn: z.boolean().default(false),
  role: AdminRoleSchema.default('OWNER'),
  /** `start` answers 500: the design's "service error" state. */
  startFails: z.boolean().default(false),
  /** The login is refused in the bot ("Bu men emasman"): status DENIED. */
  deny: z.boolean().default(false),
  /** Status polls answered PENDING before CODE_SENT. */
  pendingPolls: z.number().int().min(0).max(100).default(1),
  /**
   * How the read endpoints answer (the four view states of every screen): `data` (fixtures),
   * `empty` (no rows), `error` (500), `loading` (no answer until the request is dropped).
   */
  scenario: z.enum(['data', 'empty', 'error', 'loading']).default('data'),
});

export type MockState = z.infer<typeof stateSchema>;

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

let memory: MockState = stateSchema.parse({});

export function readMockState(): MockState {
  const raw = storage()?.getItem(MOCK_STATE_KEY);
  if (raw === null || raw === undefined) return memory;
  try {
    const parsed = stateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : memory;
  } catch {
    return memory;
  }
}

export function writeMockState(patch: Partial<MockState>): MockState {
  const next = { ...readMockState(), ...patch };
  memory = next;
  storage()?.setItem(MOCK_STATE_KEY, JSON.stringify(next));
  return next;
}

export function mockRole(): AdminRole {
  return readMockState().role;
}

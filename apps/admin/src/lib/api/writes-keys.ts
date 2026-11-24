// `POST /admin/write-keys/void` (docs/04 «Kalitni bekor qilish», 9-B SA-1, owner Q2 = A): the
// panel's answer to an unknown outcome. The API settles the old key by its audit row id: either
// the action under it committed (APPLIED) or it never will (VOIDED). The CSRF header is added by
// http.ts; there is no Idempotency-Key (the route is idempotent by nature), but the call gets the
// keyed writes' timeout, so a hung void is "no verdict", never a verdict.
import {
  AdminWriteKeyVoidResponseSchema,
  type AdminKeyedWritePermission,
  type AdminWriteKeyVoidBody,
  type AdminWriteKeyVoidResponse,
} from '@repo/shared';
import type { MockGroupName } from '../../env-schema';
import { apiFetch } from './client';

type Area = AdminKeyedWritePermission extends `${infer A}.${string}` ? A : never;

/**
 * The mock group of the write a key belongs to: the void must reach the same "server" as that
 * write (in the dev mock the tombstones live beside the replays), and the real API otherwise.
 */
const GROUP_OF_AREA: Readonly<Record<Area, MockGroupName>> = {
  orders: 'orders',
  users: 'users',
  payments: 'payments',
  cards: 'payments',
  catalog: 'catalog',
  fx: 'settings',
  admins: 'admins',
  sessions: 'admins',
  queues: 'queues',
};

export function voidGroupOf(action: AdminKeyedWritePermission): MockGroupName {
  return GROUP_OF_AREA[action.slice(0, action.indexOf('.')) as Area];
}

export type VoidWriteKey = (body: AdminWriteKeyVoidBody) => Promise<AdminWriteKeyVoidResponse>;

export const voidWriteKey: VoidWriteKey = (body) =>
  apiFetch(
    {
      method: 'POST',
      path: '/admin/write-keys/void',
      body,
      writeTimeout: true,
      group: voidGroupOf(body.action),
    },
    AdminWriteKeyVoidResponseSchema,
  );

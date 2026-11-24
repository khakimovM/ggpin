// Every write route of the dev mock, in one list for the transport. Owned in turn by S7b (users,
// payments, cards), S8b (catalog), S9b (admins) and 9B-3 (the key void): each adds its module here.
import type { MockRoute } from './router';
import { adminWriteRoutes } from './write-admins';
import { catalogWriteRoutes } from './write-catalog';
import { writeKeyRoutes } from './write-keys';
import { paymentWriteRoutes } from './write-payments';
import { userWriteRoutes } from './write-users';

export const writeRoutes: readonly MockRoute[] = [
  ...userWriteRoutes,
  ...paymentWriteRoutes,
  ...catalogWriteRoutes,
  ...adminWriteRoutes,
  ...writeKeyRoutes,
];

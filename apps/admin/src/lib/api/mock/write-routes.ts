// Every write route of the dev mock, in one list for the transport. Owned in turn by S7b (users,
// payments, cards), S8b (catalog) and S9b (admins): each slice adds its own module here.
import type { MockRoute } from './router';
import { paymentWriteRoutes } from './write-payments';
import { userWriteRoutes } from './write-users';

export const writeRoutes: readonly MockRoute[] = [...userWriteRoutes, ...paymentWriteRoutes];

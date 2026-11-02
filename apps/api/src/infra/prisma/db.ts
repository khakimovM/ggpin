import type { Prisma } from '@repo/db';

/** The Prisma client inside a `$transaction` callback (the root client satisfies it too). */
export type Db = Prisma.TransactionClient;

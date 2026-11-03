// Entry point of `prisma db seed` (see prisma.config.ts). Compiled by `npm run db:seed` first,
// because the generated Prisma client is TypeScript with `.js` import specifiers that Node's
// type stripping cannot resolve.
import { createPrismaClient } from '../src/index.js';
import { seedCatalog } from './seed/seed-catalog.js';

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is not set; refusing to seed.');
  }
  // Unset NODE_ENV counts as non-production (local dev); only an explicit "production" is gated.
  const isProduction = process.env['NODE_ENV'] === 'production';

  const db = createPrismaClient(databaseUrl);
  try {
    const created = await seedCatalog(db, { activateProducts: !isProduction });
    console.log(
      `seed: created ${created.categories} categories, ${created.products} products, ` +
        `${created.routes} routes, ${created.skus} skus` +
        (isProduction ? ' (production: products inactive)' : ''),
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('seed failed:', error);
  process.exitCode = 1;
});

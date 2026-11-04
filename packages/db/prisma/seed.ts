// Entry point of `prisma db seed` (see prisma.config.ts). Compiled by `npm run db:seed` first,
// because the generated Prisma client is TypeScript with `.js` import specifiers that Node's
// type stripping cannot resolve.
import { createPrismaClient } from '../src/index.js';
import { inactiveProductsNote, shouldActivateProducts } from './seed/activation.js';
import { seedCatalog } from './seed/seed-catalog.js';

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is not set; refusing to seed.');
  }
  // Fails closed: only NODE_ENV=development or test publishes the demo products.
  const activateProducts = shouldActivateProducts(process.env['NODE_ENV']);

  const db = createPrismaClient(databaseUrl);
  try {
    const created = await seedCatalog(db, { activateProducts });
    console.log(
      `seed: created ${created.categories} categories, ${created.products} products, ` +
        `${created.routes} routes, ${created.skus} skus` +
        inactiveProductsNote(activateProducts),
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('seed failed:', error);
  process.exitCode = 1;
});

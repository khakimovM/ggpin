// Entry point of `prisma db seed` (see prisma.config.ts). Compiled by `npm run db:seed` first,
// because the generated Prisma client is TypeScript with `.js` import specifiers that Node's
// type stripping cannot resolve.
import { createPrismaClient, markDevDatabase } from '../src/index.js';
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
    // D-52 r2: the dev marker (ggpin.env = dev) is set by the same explicit NODE_ENV check, so a
    // seed run on a real database never marks it; a production boot refuses a marked database.
    if (activateProducts) {
      await markDevDatabase(db);
      console.log('seed: database marked as dev (ggpin.env = dev)');
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('seed failed:', error);
  process.exitCode = 1;
});

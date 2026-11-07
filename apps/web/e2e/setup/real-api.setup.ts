import { test as setup } from '@playwright/test';
import { e2eDatabase } from '../support/db-guard';
import { ensureDatabase, migrateDatabase } from '../support/real-db';

// Runs once before the `real-api` project (and only before it: the viewport projects fake the
// API and need no database). Creates the e2e database when it is missing and migrates it.
setup('the e2e database exists and is migrated', async () => {
  setup.setTimeout(180_000);
  const { url } = e2eDatabase();
  await ensureDatabase(url);
  migrateDatabase(url);
});

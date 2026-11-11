-- Runs once, only on a fresh data volume (docker-entrypoint-initdb.d), i.e. only on a dev box.
-- D-52 r2: the dev marker lets dev tools (bank-feed inject) write here, and makes a
-- NODE_ENV=production worker/API refuse this database. A production database never has it.
-- Both dev databases are marked: ggpin and ggpin_test (r3 CR-3: kept on purpose; a _test name
-- is refused in production anyway). It is read from pg_db_role_setting (the database-level row,
-- r3 L-1), never from the session, so it cannot be faked or hidden with URL options/PGOPTIONS.
-- Existing volumes: npm run db:seed (NODE_ENV=development) sets the same marker, or once per db:
-- docker compose exec -T postgres psql -U ggpin -d ggpin -c "ALTER DATABASE ggpin SET ggpin.env = 'dev'"
-- (the same with ggpin_test; optional there, its _test name already allows dev tools).
ALTER DATABASE ggpin SET ggpin.env = 'dev';
ALTER DATABASE ggpin_test SET ggpin.env = 'dev';

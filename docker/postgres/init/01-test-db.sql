-- Runs once, only on a fresh data volume (docker-entrypoint-initdb.d). Existing volumes get the
-- same database with: docker compose exec -T postgres createdb -U ggpin ggpin_test
-- DB tests refuse to run against any database whose name does not end in "_test".
CREATE DATABASE ggpin_test OWNER ggpin;

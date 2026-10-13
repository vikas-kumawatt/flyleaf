-- Database roles for production (deploy/db-roles.sh applies this as the
-- container's superuser). Idempotent: safe to run on every provision, release
-- and restore.
--
--   flyleaf        the container's superuser (POSTGRES_USER). Backups,
--                  restores and this file only; no app process uses it.
--   flyleaf_owner  owns the database, its schemas, tables and functions, and
--                  runs the migrations (MIGRATION_DATABASE_URL). Not a superuser:
--                  pg_trgm and unaccent are trusted extensions, which the
--                  database's owner may create.
--   flyleaf_app    the API and the worker (DATABASE_URL). SELECT, INSERT,
--                  UPDATE, DELETE on the app's tables and nothing else: it can
--                  create no table, schema, temp table or database, and cannot
--                  drop, alter or truncate anything the owner owns.
--                  The one thing it owns is the `pgboss` schema. pg-boss
--                  manages that schema itself at run time -- create_queue()
--                  creates a partition table per queue, and its maintenance
--                  adds and drops queue_stats partitions -- so whoever runs
--                  pg-boss must own it. That is library-internal job state,
--                  left out of backups; the app's data is not in it.
--
-- Variables (set by db-roles.sh): owner_password, app_password, db.

\set ON_ERROR_STOP on

-- ---- cluster level -----------------------------------------------------------
SELECT 'CREATE ROLE flyleaf_owner' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flyleaf_owner') \gexec
SELECT 'CREATE ROLE flyleaf_app' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flyleaf_app') \gexec
ALTER ROLE flyleaf_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'owner_password';
ALTER ROLE flyleaf_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';
-- The owner may not hand its rights to the app, nor the app take the owner's.
SELECT 'REVOKE flyleaf_owner FROM flyleaf_app'
  WHERE EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = 'flyleaf_owner'::regrole AND member = 'flyleaf_app'::regrole) \gexec
-- migrate.ts stores pg_trgm's threshold on the database (ALTER DATABASE ... SET).
-- When pg_trgm is not loaded in that session -- it already existed, as after
-- a catalog restore -- Postgres sees an unknown placeholder, which only a
-- superuser or a role granted SET on it may store.
GRANT SET ON PARAMETER pg_trgm.similarity_threshold TO flyleaf_owner;

-- ---- the database ---------------------------------------------------------------
SELECT format('CREATE DATABASE %I OWNER flyleaf_owner', :'db')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
ALTER DATABASE :"db" OWNER TO flyleaf_owner;
-- PUBLIC gets CONNECT and TEMP on every database by default. Neither stays.
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO flyleaf_app;

\connect :"db"

-- PUBLIC may not create in public (already so since Postgres 15; stated anyway).
ALTER SCHEMA public OWNER TO flyleaf_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO flyleaf_app;

-- Everything in public and drizzle belongs to the owner, whoever created it
-- (a migration run as the superuser by hand, a restore without --role).
-- Extension members are the extension's business and are skipped; sequences
-- that belong to a column move with their table.
DO $$
DECLARE r record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
    EXECUTE 'ALTER SCHEMA drizzle OWNER TO flyleaf_owner';
  END IF;
  FOR r IN
    SELECT c.oid, n.nspname, c.relname, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'drizzle')
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND pg_get_userbyid(c.relowner) <> 'flyleaf_owner'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i')))
  LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO flyleaf_owner',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                     WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      r.nspname, r.relname);
  END LOOP;
  FOR r IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'drizzle')
      AND pg_get_userbyid(p.proowner) <> 'flyleaf_owner'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO flyleaf_owner', r.oid::regprocedure);
  END LOOP;
  FOR r IN
    SELECT t.oid FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname IN ('public', 'drizzle') AND t.typtype IN ('e', 'd', 'c')
      AND (t.typtype <> 'c' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))
      AND pg_get_userbyid(t.typowner) <> 'flyleaf_owner'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO flyleaf_owner', r.oid::regtype);
  END LOOP;
END $$;

-- The app's rights: rows, not structure. No TRUNCATE, REFERENCES or TRIGGER.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flyleaf_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO flyleaf_app;
GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO flyleaf_app;
-- And the same on whatever later migrations create (they run as the owner).
ALTER DEFAULT PRIVILEGES FOR ROLE flyleaf_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flyleaf_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flyleaf_owner IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO flyleaf_app;

-- pg-boss's schema, owned by the role that runs pg-boss (see the top).
SELECT 'CREATE SCHEMA pgboss AUTHORIZATION flyleaf_app'
  WHERE NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') \gexec
DO $$
DECLARE r record;
BEGIN
  IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'pgboss') <> 'flyleaf_app' THEN
    EXECUTE 'ALTER SCHEMA pgboss OWNER TO flyleaf_app';
  END IF;
  FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'pgboss' AND c.relkind IN ('r', 'p') AND pg_get_userbyid(c.relowner) <> 'flyleaf_app'
  LOOP
    EXECUTE format('ALTER TABLE pgboss.%I OWNER TO flyleaf_app', r.relname);
  END LOOP;
  FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'pgboss' AND pg_get_userbyid(p.proowner) <> 'flyleaf_app'
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO flyleaf_app', r.oid::regprocedure);
  END LOOP;
  FOR r IN SELECT t.oid FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'pgboss' AND t.typtype = 'e' AND pg_get_userbyid(t.typowner) <> 'flyleaf_app'
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO flyleaf_app', r.oid::regtype);
  END LOOP;
END $$;

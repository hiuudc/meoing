-- The Data API hardening migration removed every privilege that PostgREST can
-- use directly. PostgreSQL 17 still retained non-CRUD default table grants
-- (MAINTAIN, REFERENCES, TRIGGER, and TRUNCATE) plus sequence UPDATE for the
-- Supabase API roles. Meoing never exposes application data through the public
-- schema, so keep future postgres-created public tables and sequences
-- fail-closed with no inherited grants.
alter default privileges for role postgres in schema public
  revoke all privileges on tables
  from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke all privileges on sequences
  from anon, authenticated, service_role;

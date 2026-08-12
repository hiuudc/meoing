begin;

alter role meoing_runtime
  nologin
  noinherit
  nocreatedb
  nocreaterole
  noreplication
  nobypassrls;

alter role meoing_maintenance
  nologin
  noinherit
  nocreatedb
  nocreaterole
  noreplication
  nobypassrls;

-- Environment-specific login roles and their passwords are provisioned
-- outside migrations. Harden them when present without re-enabling LOGIN,
-- which an operator may have disabled during incident response.
do $$
begin
  if exists (
    select 1
    from pg_roles
    where rolname = 'meoing_api_login'
  ) then
    alter role meoing_api_login
      noinherit
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls
      connection limit 25;
    alter role meoing_api_login set search_path = pg_catalog;
    alter role meoing_api_login
      set idle_in_transaction_session_timeout = '30s';
    grant meoing_runtime to meoing_api_login
      with admin false, inherit false, set true;
    revoke meoing_maintenance from meoing_api_login;
  end if;

  if exists (
    select 1
    from pg_roles
    where rolname = 'meoing_maintenance_login'
  ) then
    alter role meoing_maintenance_login
      noinherit
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls
      connection limit 8;
    alter role meoing_maintenance_login set search_path = pg_catalog;
    alter role meoing_maintenance_login
      set idle_in_transaction_session_timeout = '30s';
    grant meoing_maintenance to meoing_maintenance_login
      with admin false, inherit false, set true;
    revoke meoing_runtime from meoing_maintenance_login;
  end if;
end
$$;

commit;

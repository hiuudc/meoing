begin;

-- Hyperdrive may open up to 20 origin connections for the API pool. Keep the
-- login role slightly above that pool size so normal connection churn cannot
-- trip PostgreSQL's per-role limit. Login roles are provisioned separately
-- because their passwords are environment secrets, so local resets may not
-- have this role yet.
do $$
begin
  if exists (
    select 1
    from pg_roles
    where rolname = 'meoing_api_login'
  ) then
    alter role meoing_api_login connection limit 25;
  end if;
end
$$;

commit;

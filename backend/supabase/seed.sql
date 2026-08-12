insert into private.deployment_identity (
  singleton,
  environment,
  supabase_project_ref
)
values (
  true,
  'local',
  'local'
)
on conflict (singleton) do update
set environment = excluded.environment,
    supabase_project_ref = excluded.supabase_project_ref,
    configured_at = statement_timestamp();

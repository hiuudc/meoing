begin;

create table private.deployment_identity (
  singleton boolean primary key default true,
  environment text not null,
  supabase_project_ref text not null,
  configured_at timestamptz not null default statement_timestamp(),
  constraint deployment_identity_singleton check (singleton),
  constraint deployment_identity_environment check (
    environment in ('local', 'staging', 'production')
  ),
  constraint deployment_identity_project_ref check (
    (
      environment = 'local'
      and supabase_project_ref = 'local'
    )
    or (
      environment in ('staging', 'production')
      and supabase_project_ref ~ '^[a-z0-9]{20}$'
    )
  )
);

alter table private.deployment_identity enable row level security;
alter table private.deployment_identity force row level security;

revoke all on table private.deployment_identity
  from public, anon, authenticated, service_role, meoing_runtime, meoing_maintenance;

create or replace function private.assert_database_identity(
  p_environment text,
  p_supabase_project_ref text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_identity private.deployment_identity%rowtype;
begin
  select identity.*
  into v_identity
  from private.deployment_identity as identity
  where identity.singleton;

  if not found
     or v_identity.environment is distinct from p_environment
     or v_identity.supabase_project_ref is distinct from p_supabase_project_ref then
    raise exception using
      errcode = '57P03',
      message = 'DATABASE_IDENTITY_MISMATCH';
  end if;

  return jsonb_build_object(
    'environment', v_identity.environment,
    'supabaseProjectRef', v_identity.supabase_project_ref
  );
end;
$$;

revoke execute on function private.assert_database_identity(text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.assert_database_identity(text, text)
  to meoing_runtime, meoing_maintenance;

comment on table private.deployment_identity is
  'One environment-owned marker used to prevent a Worker or Hyperdrive binding from targeting the wrong database.';
comment on function private.assert_database_identity(text, text) is
  'Fails closed unless the caller-provided Worker environment and Supabase project ref match this database marker.';

commit;

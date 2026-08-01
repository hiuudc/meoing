begin;

create or replace function private.enforce_file_storage_budget()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_environment text;
  v_budget_bytes bigint;
  v_reserved_bytes bigint;
begin
  -- Serialize every pending-file reservation so concurrent users cannot push
  -- the account over the R2 storage allocation between separate transactions.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('file-upload:storage-budget', 0)
  );

  -- A racing retry with the same idempotency key must not reserve the bytes a
  -- second time. The RPC also returns the existing row before reaching INSERT;
  -- this check closes the small concurrent-insert window.
  if new.idempotency_key is not null
     and exists (
       select 1
       from app.file_assets as existing
       where existing.owner_id = new.owner_id
         and existing.idempotency_key = new.idempotency_key
     ) then
    return new;
  end if;

  select identity.environment
  into v_environment
  from private.deployment_identity as identity
  where identity.singleton;

  if not found then
    raise exception using
      errcode = '57P03',
      message = 'DATABASE_IDENTITY_MISMATCH';
  end if;

  v_budget_bytes := case v_environment
    when 'production' then 4831838208 -- 4.5 GiB
    when 'staging' then 536870912 -- 0.5 GiB
    when 'local' then 536870912 -- exercise the staging guard locally
    else null
  end;

  if v_budget_bytes is null then
    raise exception using
      errcode = '57P03',
      message = 'DATABASE_IDENTITY_MISMATCH';
  end if;

  select coalesce(sum(asset.expected_size_bytes), 0)
  into v_reserved_bytes
  from app.file_assets as asset
  where asset.status in ('pending', 'ready');

  if v_reserved_bytes + new.expected_size_bytes > v_budget_bytes then
    raise exception using
      errcode = '54000',
      message = 'STORAGE_BUDGET_REACHED';
  end if;

  return new;
end;
$$;

revoke execute on function private.enforce_file_storage_budget()
  from public, anon, authenticated, service_role, meoing_runtime, meoing_maintenance;

create trigger file_assets_enforce_storage_budget
  before insert on app.file_assets
  for each row execute function private.enforce_file_storage_budget();

comment on function private.enforce_file_storage_budget() is
  'Atomically reserves the environment R2 storage allocation, including pending uploads.';

commit;

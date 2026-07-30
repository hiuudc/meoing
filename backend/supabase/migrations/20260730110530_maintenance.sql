begin;

create or replace function private.maintenance_cleanup(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_size integer := least(
    greatest(coalesce((p_input ->> 'batchSize')::integer, 500), 1),
    1000
  );
  v_expired_rate_buckets integer := 0;
  v_expired_reservations integer := 0;
  v_cleared_progress integer := 0;
  v_deleted_revisions integer := 0;
  v_deleted_audit_logs integer := 0;
  v_deleted_units integer := 0;
  v_expired_uploads integer := 0;
  v_due_collection_candidates jsonb := '[]'::jsonb;
  v_due_collection_ids jsonb := '[]'::jsonb;
  v_due_user_ids jsonb := '[]'::jsonb;
  v_due_asset_ids jsonb := '[]'::jsonb;
  v_r2_keys jsonb := '[]'::jsonb;
  v_auth_user_ids jsonb := '[]'::jsonb;
begin
  if session_user <> 'postgres'
     and not pg_has_role(session_user, 'meoing_maintenance', 'member') then
    raise exception using errcode = '42501', message = 'MAINTENANCE_ROLE_REQUIRED';
  end if;

  perform set_config('app.maintenance_cleanup', 'on', true);
  perform set_config('statement_timeout', '25s', true);
  perform set_config('lock_timeout', '2s', true);

  with due as (
    select scope, abuse_key, window_started_at
    from private.rate_limit_buckets
    where expires_at <= statement_timestamp()
    order by expires_at, scope
    limit v_batch_size
    for update skip locked
  )
  delete from private.rate_limit_buckets as bucket
  using due
  where bucket.scope = due.scope
    and bucket.abuse_key = due.abuse_key
    and bucket.window_started_at = due.window_started_at;
  get diagnostics v_expired_rate_buckets = row_count;

  with due as (
    select username
    from app.username_reservations
    where reservation_type = 'released'
      and expires_at <= statement_timestamp()
    order by expires_at, username
    limit v_batch_size
    for update skip locked
  )
  delete from app.username_reservations as reservation
  using due
  where reservation.username = due.username;
  get diagnostics v_expired_reservations = row_count;

  with due as (
    select id
    from app.lesson_progress
    where raw_expires_at <= statement_timestamp()
      and attempts <> '[]'::jsonb
    order by raw_expires_at, id
    limit v_batch_size
    for update skip locked
  )
  update app.lesson_progress as progress
  set attempts = '[]'::jsonb,
      revision = progress.revision + 1
  from due
  where progress.id = due.id;
  get diagnostics v_cleared_progress = row_count;

  with ranked as (
    select
      revision.id,
      revision.created_at,
      row_number() over (
        partition by revision.unit_id
        order by revision.revision desc
      ) as retention_rank
    from app.unit_revisions as revision
  ),
  due as (
    select id
    from ranked
    where created_at < statement_timestamp() - interval '30 days'
      and retention_rank > 10
    order by created_at, id
    limit v_batch_size
  )
  delete from app.unit_revisions as revision
  using due
  where revision.id = due.id;
  get diagnostics v_deleted_revisions = row_count;

  with due as (
    select id
    from app.collection_audit_logs
    where created_at < statement_timestamp() - interval '90 days'
    order by created_at, id
    limit v_batch_size
    for update skip locked
  )
  delete from app.collection_audit_logs as audit
  using due
  where audit.id = due.id;
  get diagnostics v_deleted_audit_logs = row_count;

  with due as (
    select id
    from app.units as unit
    where unit.delete_after <= statement_timestamp()
      and not exists (
        select 1
        from app.lessons as lesson
        where lesson.unit_id = unit.id
      )
    order by delete_after, id
    limit v_batch_size
    for update skip locked
  )
  delete from app.units as unit
  using due
  where unit.id = due.id;
  get diagnostics v_deleted_units = row_count;

  with due as (
    select id
    from app.file_assets
    where status = 'pending'
      and pending_expires_at <= statement_timestamp()
    order by pending_expires_at, id
    limit v_batch_size
    for update skip locked
  )
  update app.file_assets as asset
  set status = 'deleted',
      deleted_at = statement_timestamp()
  from due
  where asset.id = due.id;
  get diagnostics v_expired_uploads = row_count;

  select coalesce(
    jsonb_agg(collection.id order by collection.delete_after, collection.id),
    '[]'::jsonb
  )
  into v_due_collection_candidates
  from (
    select id, delete_after
    from app.collections
    where delete_after <= statement_timestamp()
    order by delete_after, id
    limit v_batch_size
  ) as collection;

  select coalesce(
    jsonb_agg(profile.user_id order by profile.delete_after, profile.user_id),
    '[]'::jsonb
  )
  into v_due_user_ids
  from (
    select user_id, delete_after
    from app.profiles
    where delete_after <= statement_timestamp()
    order by delete_after, user_id
    limit v_batch_size
  ) as profile;

  select coalesce(
    jsonb_agg(asset.id order by asset.created_at, asset.id),
    '[]'::jsonb
  )
  into v_due_asset_ids
  from (
    select id, created_at
    from app.file_assets
    where (
        status = 'deleted'
        and reference_count = 0
      )
      or (
        collection_id is null
        and owner_id in (
          select value::uuid
          from jsonb_array_elements_text(v_due_user_ids) as due_user(value)
        )
      )
      or collection_id in (
        select value::uuid
        from jsonb_array_elements_text(v_due_collection_candidates)
          as due_collection(value)
      )
    order by created_at, id
    limit v_batch_size
    for update skip locked
  ) as asset;

  select coalesce(jsonb_agg(asset.r2_key order by asset.r2_key), '[]'::jsonb)
  into v_r2_keys
  from app.file_assets as asset
  where asset.id in (
    select value::uuid
    from jsonb_array_elements_text(v_due_asset_ids) as due_asset(value)
  );

  select coalesce(jsonb_agg(candidate.id order by candidate.id), '[]'::jsonb)
  into v_due_collection_ids
  from (
    select value::uuid as id
    from jsonb_array_elements_text(v_due_collection_candidates)
  ) as candidate
  where not exists (
    select 1
    from app.file_assets as asset
    where asset.collection_id = candidate.id
  );

  select coalesce(jsonb_agg(candidate.id order by candidate.id), '[]'::jsonb)
  into v_auth_user_ids
  from (
    select value::uuid as id
    from jsonb_array_elements_text(v_due_user_ids)
  ) as candidate
  where not exists (
      select 1
      from app.collections as collection
      where collection.owner_id = candidate.id
    )
    and not exists (
      select 1
      from app.file_assets as asset
      where asset.owner_id = candidate.id
        and asset.collection_id is null
    );

  return jsonb_build_object(
    'expiredRateLimitBuckets', v_expired_rate_buckets,
    'expiredUsernameReservations', v_expired_reservations,
    'clearedProgressAnswers', v_cleared_progress,
    'deletedUnitRevisions', v_deleted_revisions,
    'deletedAuditLogs', v_deleted_audit_logs,
    'deletedUnits', v_deleted_units,
    'expiredUploads', v_expired_uploads,
    'dueCollections', jsonb_array_length(v_due_collection_ids),
    'dueAssets', jsonb_array_length(v_due_asset_ids),
    'deletedCollections', 0,
    'purgedAssets', 0,
    'dueCollectionIds', v_due_collection_ids,
    'dueAssetIds', v_due_asset_ids,
    'r2Keys', v_r2_keys,
    'authUserIds', v_auth_user_ids
  );
end;
$$;

create or replace function private.maintenance_finalize(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection_ids jsonb := coalesce(p_input -> 'collectionIds', '[]'::jsonb);
  v_asset_ids jsonb := coalesce(p_input -> 'assetIds', '[]'::jsonb);
  v_requested_auth_user_ids jsonb := coalesce(
    p_input -> 'authUserIds',
    '[]'::jsonb
  );
  v_auth_user_ids jsonb := '[]'::jsonb;
  v_deleted_collections integer := 0;
  v_purged_assets integer := 0;
begin
  if session_user <> 'postgres'
     and not pg_has_role(session_user, 'meoing_maintenance', 'member') then
    raise exception using errcode = '42501', message = 'MAINTENANCE_ROLE_REQUIRED';
  end if;
  if jsonb_typeof(v_collection_ids) is distinct from 'array'
     or jsonb_typeof(v_asset_ids) is distinct from 'array'
     or jsonb_typeof(v_requested_auth_user_ids) is distinct from 'array'
     or jsonb_array_length(v_collection_ids) > 1000
     or jsonb_array_length(v_asset_ids) > 1000
     or jsonb_array_length(v_requested_auth_user_ids) > 1000 then
    raise exception using errcode = '22023', message = 'INVALID_FINALIZE_BATCH';
  end if;

  perform set_config('app.maintenance_cleanup', 'on', true);
  perform set_config('statement_timeout', '25s', true);
  perform set_config('lock_timeout', '2s', true);

  with requested as (
    select value::uuid as id
    from jsonb_array_elements_text(v_asset_ids)
  ),
  due as (
    select asset.id
    from app.file_assets as asset
    join requested on requested.id = asset.id
    where (
        asset.status = 'deleted'
        and asset.reference_count = 0
      )
      or (
        asset.collection_id is null
        and exists (
          select 1
          from app.profiles as profile
          where profile.user_id = asset.owner_id
            and profile.delete_after <= statement_timestamp()
        )
      )
      or exists (
        select 1
        from app.collections as collection
        where collection.id = asset.collection_id
          and collection.delete_after <= statement_timestamp()
      )
    order by asset.id
    for update of asset
  )
  delete from app.file_assets as asset
  using due
  where asset.id = due.id;
  get diagnostics v_purged_assets = row_count;

  with requested as (
    select value::uuid as id
    from jsonb_array_elements_text(v_collection_ids)
  ),
  due as (
    select collection.id
    from app.collections as collection
    join requested on requested.id = collection.id
    where collection.delete_after <= statement_timestamp()
      and not exists (
        select 1
        from app.file_assets as asset
        where asset.collection_id = collection.id
      )
    order by collection.id
    for update of collection
  )
  delete from app.collections as collection
  using due
  where collection.id = due.id;
  get diagnostics v_deleted_collections = row_count;

  select coalesce(jsonb_agg(ready.user_id order by ready.user_id), '[]'::jsonb)
  into v_auth_user_ids
  from (
    select profile.user_id
    from app.profiles as profile
    where profile.user_id in (
        select value::uuid
        from jsonb_array_elements_text(v_requested_auth_user_ids)
          as requested_user(value)
      )
      and profile.delete_after <= statement_timestamp()
      and not exists (
        select 1
        from app.collections as collection
        where collection.owner_id = profile.user_id
      )
      and not exists (
        select 1
        from app.file_assets as asset
        where asset.owner_id = profile.user_id
          and asset.collection_id is null
      )
    order by profile.user_id
    for update of profile
  ) as ready;

  return jsonb_build_object(
    'deletedCollections', v_deleted_collections,
    'purgedAssets', v_purged_assets,
    'authUserIds', v_auth_user_ids
  );
end;
$$;

revoke execute on function private.maintenance_cleanup(jsonb)
  from public, anon, authenticated, meoing_runtime;
revoke execute on function private.maintenance_finalize(jsonb)
  from public, anon, authenticated, meoing_runtime;
grant usage on schema private to meoing_maintenance;
grant execute on function private.maintenance_cleanup(jsonb)
  to meoing_maintenance;
grant execute on function private.maintenance_finalize(jsonb)
  to meoing_maintenance;

commit;

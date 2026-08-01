begin;

create or replace function private.maintenance_observe(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sample_percent integer := 5;
  v_global_estimated_rows bigint := 0;
  v_collection_estimated_rows bigint := 0;
  v_global_sampled_rows integer := 0;
  v_collection_sampled_rows integer := 0;
  v_global_p95_bytes bigint := 0;
  v_collection_p95_bytes bigint := 0;
  v_max_sampled_bytes bigint := 0;
  v_sampled_rows_over_threshold integer := 0;
  v_waiting_lock_count integer := 0;
  v_oldest_waiting_query_age_ms bigint := 0;
  v_api_connections integer := 0;
  v_maintenance_connections integer := 0;
begin
  if session_user <> 'postgres'
     and not pg_has_role(session_user, 'meoing_maintenance', 'member') then
    raise exception using errcode = '42501', message = 'MAINTENANCE_ROLE_REQUIRED';
  end if;

  perform set_config('statement_timeout', '10s', true);
  perform set_config('lock_timeout', '1s', true);

  select
    coalesce(max(case
      when namespace.nspname = 'app'
       and relation.relname = 'user_language_stats'
      then greatest(relation.reltuples, 0)
    end), 0)::bigint,
    coalesce(max(case
      when namespace.nspname = 'app'
       and relation.relname = 'collection_user_language_stats'
      then greatest(relation.reltuples, 0)
    end), 0)::bigint
  into v_global_estimated_rows, v_collection_estimated_rows
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = relation.relnamespace
  where namespace.nspname = 'app'
    and relation.relname in (
      'user_language_stats',
      'collection_user_language_stats'
    );

  with global_sample as materialized (
    select
      pg_catalog.pg_column_size(stats.aggregate)::bigint
        + pg_catalog.pg_column_size(stats.words)::bigint
        + pg_catalog.pg_column_size(stats.phrases)::bigint
        + pg_catalog.pg_column_size(stats.sentences)::bigint
        as json_bytes
    from app.user_language_stats as stats tablesample system (5)
    limit 10000
  ),
  global_rows as materialized (
    select sample.json_bytes
    from global_sample as sample
    union all
    (
      select
        pg_catalog.pg_column_size(stats.aggregate)::bigint
          + pg_catalog.pg_column_size(stats.words)::bigint
          + pg_catalog.pg_column_size(stats.phrases)::bigint
          + pg_catalog.pg_column_size(stats.sentences)::bigint
          as json_bytes
      from app.user_language_stats as stats
      where not exists (select 1 from global_sample)
      limit 1000
    )
  ),
  collection_sample as materialized (
    select
      pg_catalog.pg_column_size(stats.aggregate)::bigint
        + pg_catalog.pg_column_size(stats.words)::bigint
        + pg_catalog.pg_column_size(stats.phrases)::bigint
        + pg_catalog.pg_column_size(stats.sentences)::bigint
        as json_bytes
    from app.collection_user_language_stats as stats tablesample system (5)
    limit 10000
  ),
  collection_rows as materialized (
    select sample.json_bytes
    from collection_sample as sample
    union all
    (
      select
        pg_catalog.pg_column_size(stats.aggregate)::bigint
          + pg_catalog.pg_column_size(stats.words)::bigint
          + pg_catalog.pg_column_size(stats.phrases)::bigint
          + pg_catalog.pg_column_size(stats.sentences)::bigint
          as json_bytes
      from app.collection_user_language_stats as stats
      where not exists (select 1 from collection_sample)
      limit 1000
    )
  ),
  global_summary as (
    select
      count(*)::integer as sampled_rows,
      coalesce(
        percentile_disc(0.95) within group (order by json_bytes),
        0
      )::bigint as p95_bytes,
      coalesce(max(json_bytes), 0)::bigint as max_bytes,
      count(*) filter (where json_bytes > 262144)::integer
        as rows_over_threshold
    from global_rows
  ),
  collection_summary as (
    select
      count(*)::integer as sampled_rows,
      coalesce(
        percentile_disc(0.95) within group (order by json_bytes),
        0
      )::bigint as p95_bytes,
      coalesce(max(json_bytes), 0)::bigint as max_bytes,
      count(*) filter (where json_bytes > 262144)::integer
        as rows_over_threshold
    from collection_rows
  )
  select
    global_summary.sampled_rows,
    collection_summary.sampled_rows,
    global_summary.p95_bytes,
    collection_summary.p95_bytes,
    greatest(global_summary.max_bytes, collection_summary.max_bytes),
    global_summary.rows_over_threshold
      + collection_summary.rows_over_threshold
  into
    v_global_sampled_rows,
    v_collection_sampled_rows,
    v_global_p95_bytes,
    v_collection_p95_bytes,
    v_max_sampled_bytes,
    v_sampled_rows_over_threshold
  from global_summary
  cross join collection_summary;

  select
    count(*)::integer,
    coalesce(
      max(
        greatest(
          extract(
            epoch from statement_timestamp() - activity.query_start
          ) * 1000,
          0
        )
      ),
      0
    )::bigint
  into v_waiting_lock_count, v_oldest_waiting_query_age_ms
  from pg_catalog.pg_locks as lock
  join pg_catalog.pg_stat_activity as activity
    on activity.pid = lock.pid
  where not lock.granted
    and activity.datname = current_database();

  select
    count(*) filter (
      where activity.application_name = 'meoing-api'
    )::integer,
    count(*) filter (
      where activity.application_name = 'meoing-maintenance'
    )::integer
  into v_api_connections, v_maintenance_connections
  from pg_catalog.pg_stat_activity as activity
  where activity.datname = current_database();

  return jsonb_build_object(
    'statsSamplePercent', v_sample_percent,
    'estimatedGlobalStatsRows', v_global_estimated_rows,
    'estimatedCollectionStatsRows', v_collection_estimated_rows,
    'sampledGlobalStatsRows', v_global_sampled_rows,
    'sampledCollectionStatsRows', v_collection_sampled_rows,
    'globalStatsP95Bytes', v_global_p95_bytes,
    'collectionStatsP95Bytes', v_collection_p95_bytes,
    'maxSampledStatsRowBytes', v_max_sampled_bytes,
    'sampledStatsRowsOver256KiB', v_sampled_rows_over_threshold,
    'waitingLockCount', v_waiting_lock_count,
    'oldestWaitingQueryAgeMs', v_oldest_waiting_query_age_ms,
    'apiConnectionCount', v_api_connections,
    'maintenanceConnectionCount', v_maintenance_connections
  );
end;
$$;

revoke execute on function private.maintenance_observe(jsonb)
  from public, anon, authenticated, meoing_runtime;
grant usage on schema private to meoing_maintenance;
grant execute on function private.maintenance_observe(jsonb)
  to meoing_maintenance;

comment on function private.maintenance_observe(jsonb) is
  'Returns bounded sampled stats-row sizes plus point-in-time lock and connection indicators for the Cron log.';

commit;

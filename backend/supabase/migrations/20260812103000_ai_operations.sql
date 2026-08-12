begin;

create table app.ai_operation_ledger (
  operation_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  collection_id uuid not null references app.collections(id) on delete cascade,
  unit_id uuid not null references app.units(id) on delete cascade,
  kind text not null check (kind in ('create_lesson', 'evaluate_answer', 'coaching')),
  status text not null check (status in ('reserved', 'completed', 'failed')),
  reservation_units integer not null check (reservation_units > 0),
  result jsonb,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  expires_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  settled_at timestamptz,
  constraint ai_operation_result_size check (
    result is null or octet_length(result::text) <= 1048576
  ),
  constraint ai_operation_result_state check (
    (status = 'completed' and result is not null and expires_at is not null and settled_at is not null)
    or (status = 'reserved' and result is null and expires_at is null and settled_at is null)
    or (status = 'failed' and result is null and settled_at is not null)
  )
);

create index ai_operation_ledger_expiry_idx
  on app.ai_operation_ledger (expires_at, operation_id)
  where expires_at is not null;

create table app.ai_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_day date not null,
  lesson_reserved integer not null default 0 check (lesson_reserved >= 0),
  lesson_used integer not null default 0 check (lesson_used >= 0),
  assistance_reserved integer not null default 0 check (assistance_reserved >= 0),
  assistance_used integer not null default 0 check (assistance_used >= 0),
  primary key (user_id, usage_day)
);

create table app.ai_global_daily_usage (
  usage_day date primary key,
  reserved_units integer not null default 0 check (reserved_units >= 0),
  used_units integer not null default 0 check (used_units >= 0)
);

create or replace function private.api_ai_operation_reserve(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_operation_id uuid := (p_input ->> 'operationId')::uuid;
  v_collection_id uuid := (p_input ->> 'collectionId')::uuid;
  v_unit_id uuid := (p_input ->> 'unitId')::uuid;
  v_kind text := p_input ->> 'kind';
  v_reservation_units integer := (p_input ->> 'reservationUnits')::integer;
  v_global_budget integer := (p_input ->> 'globalDailyBudgetUnits')::integer;
  v_day date := (now() at time zone 'utc')::date;
  v_unit app.units;
  v_ledger app.ai_operation_ledger;
  v_lesson app.lessons;
  v_profile jsonb := '{}'::jsonb;
  v_question_settings jsonb := '{}'::jsonb;
  v_snapshot jsonb;
  v_lesson_id uuid := nullif(p_input ->> 'lessonId', '')::uuid;
begin
  if v_kind not in ('create_lesson', 'evaluate_answer', 'coaching')
     or v_reservation_units is null or v_reservation_units <= 0
     or v_global_budget is null or v_global_budget <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_AI_OPERATION';
  end if;

  if not exists (
    select 1
    from app.settings
    where scope_type = 'user'
      and user_id = v_user_id
      and key = 'aiConsent'
      and value ->> 'version' = '1'
      and value ? 'grantedAt'
  ) then
    raise exception using errcode = '42501', message = 'AI_CONSENT_REQUIRED';
  end if;

  select * into v_unit
  from app.units
  where id = v_unit_id
    and collection_id = v_collection_id
    and deleted_at is null;

  if not found or not private.is_collection_member(v_collection_id) then
    raise exception using errcode = 'P0001', message = 'UNIT_NOT_FOUND';
  end if;
  if v_kind = 'create_lesson' and not private.has_collection_permission(v_collection_id, 'create_lessons') then
    raise exception using errcode = '42501', message = 'LESSON_FORBIDDEN';
  end if;

  select * into v_ledger
  from app.ai_operation_ledger
  where operation_id = v_operation_id
  for update;
  if found then
    if v_ledger.user_id <> v_user_id
       or v_ledger.collection_id <> v_collection_id
       or v_ledger.unit_id <> v_unit_id
       or v_ledger.kind <> v_kind then
      raise exception using errcode = '42501', message = 'AI_OPERATION_FORBIDDEN';
    end if;
    if v_ledger.status = 'completed' and v_ledger.expires_at > statement_timestamp() then
      return jsonb_build_object('status', 'completed', 'result', v_ledger.result);
    end if;
    if v_ledger.status = 'reserved' then
      raise exception using errcode = 'P0001', message = 'AI_OPERATION_IN_PROGRESS';
    end if;
    delete from app.ai_operation_ledger where operation_id = v_operation_id;
  end if;

  insert into app.ai_global_daily_usage (usage_day)
  values (v_day)
  on conflict (usage_day) do nothing;
  update app.ai_global_daily_usage
  set reserved_units = reserved_units + v_reservation_units
  where usage_day = v_day
    and used_units + reserved_units + v_reservation_units <= v_global_budget;
  if not found then
    raise exception using errcode = '54000', message = 'AI_GLOBAL_QUOTA';
  end if;

  insert into app.ai_daily_usage (user_id, usage_day)
  values (v_user_id, v_day)
  on conflict (user_id, usage_day) do nothing;
  if v_kind = 'create_lesson' then
    update app.ai_daily_usage
    set lesson_reserved = lesson_reserved + 1
    where user_id = v_user_id and usage_day = v_day
      and lesson_used + lesson_reserved < 5;
  else
    update app.ai_daily_usage
    set assistance_reserved = assistance_reserved + 1
    where user_id = v_user_id and usage_day = v_day
      and assistance_used + assistance_reserved < 100;
  end if;
  if not found then
    raise exception using errcode = '54000', message = 'AI_USER_QUOTA';
  end if;

  select snapshot into v_snapshot
  from app.unit_revisions
  where unit_id = v_unit.id and revision = v_unit.revision;
  if v_snapshot is null then
    v_snapshot := private.unit_snapshot(v_unit);
  end if;
  select value into v_profile
  from app.settings
  where scope_type = 'collection' and collection_id = v_collection_id and key = 'learningProfile';
  select value into v_question_settings
  from app.settings
  where scope_type = 'collection' and collection_id = v_collection_id and key = 'questionSettings';

  if v_lesson_id is not null then
    select * into v_lesson
    from app.lessons
    where id = v_lesson_id
      and unit_id = v_unit.id
      and collection_id = v_collection_id
      and deleted_at is null;
    if not found then
      raise exception using errcode = 'P0001', message = 'LESSON_NOT_FOUND';
    end if;
  end if;

  insert into app.ai_operation_ledger (
    operation_id, user_id, collection_id, unit_id, kind, status, reservation_units
  ) values (
    v_operation_id, v_user_id, v_collection_id, v_unit_id, v_kind, 'reserved', v_reservation_units
  );

  return jsonb_build_object(
    'status', 'reserved',
    'context', jsonb_build_object(
      'collection', jsonb_build_object('id', v_collection_id),
      'unit', v_snapshot,
      'learningProfile', coalesce(v_profile, '{}'::jsonb),
      'questionSettings', coalesce(v_question_settings, '{}'::jsonb),
      'lesson', case when v_lesson_id is null then null else private.lesson_json(v_lesson) end
    )
  );
end;
$$;

create or replace function private.api_ai_operation_settle(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_operation app.ai_operation_ledger;
  v_day date := (now() at time zone 'utc')::date;
  v_completed boolean := p_input ->> 'outcome' = 'completed';
begin
  select * into v_operation
  from app.ai_operation_ledger
  where operation_id = (p_input ->> 'operationId')::uuid
  for update;
  if not found or v_operation.user_id <> v_user_id then
    raise exception using errcode = 'P0001', message = 'AI_OPERATION_NOT_FOUND';
  end if;
  if v_operation.status <> 'reserved' then
    return jsonb_build_object('settled', v_operation.status = 'completed');
  end if;

  update app.ai_operation_ledger
  set status = case when v_completed then 'completed' else 'failed' end,
      result = case when v_completed then p_input -> 'result' else null end,
      input_tokens = greatest(coalesce((p_input ->> 'inputTokens')::integer, 0), 0),
      output_tokens = greatest(coalesce((p_input ->> 'outputTokens')::integer, 0), 0),
      settled_at = statement_timestamp(),
      expires_at = case when v_completed then statement_timestamp() + interval '24 hours' else null end
  where operation_id = v_operation.operation_id;

  if v_operation.kind = 'create_lesson' then
    update app.ai_daily_usage
    set lesson_reserved = greatest(lesson_reserved - 1, 0),
        lesson_used = lesson_used + case when v_completed then 1 else 0 end
    where user_id = v_user_id and usage_day = v_day;
  else
    update app.ai_daily_usage
    set assistance_reserved = greatest(assistance_reserved - 1, 0),
        assistance_used = assistance_used + case when v_completed then 1 else 0 end
    where user_id = v_user_id and usage_day = v_day;
  end if;
  update app.ai_global_daily_usage
  set reserved_units = greatest(reserved_units - v_operation.reservation_units, 0),
      used_units = used_units + case when v_completed then v_operation.reservation_units else 0 end
  where usage_day = v_day;

  return jsonb_build_object('settled', v_completed);
end;
$$;

create or replace function private.maintenance_ai_operation_cleanup(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_size integer := least(greatest(coalesce((p_input ->> 'batchSize')::integer, 500), 1), 1000);
  v_deleted integer := 0;
begin
  if session_user <> 'postgres'
     and not pg_has_role(session_user, 'meoing_maintenance', 'member') then
    raise exception using errcode = '42501', message = 'MAINTENANCE_ROLE_REQUIRED';
  end if;

  with due as (
    select operation_id
    from app.ai_operation_ledger
    where expires_at <= statement_timestamp()
    order by expires_at, operation_id
    limit v_batch_size
    for update skip locked
  )
  delete from app.ai_operation_ledger as ledger
  using due
  where ledger.operation_id = due.operation_id;
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('expiredAiOperations', v_deleted);
end;
$$;

revoke execute on function private.api_ai_operation_reserve(jsonb), private.api_ai_operation_settle(jsonb), private.maintenance_ai_operation_cleanup(jsonb)
  from public, anon, authenticated;
grant execute on function private.api_ai_operation_reserve(jsonb), private.api_ai_operation_settle(jsonb)
  to meoing_runtime;
grant execute on function private.maintenance_ai_operation_cleanup(jsonb)
  to meoing_maintenance;

commit;

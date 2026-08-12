alter table app.settings
  drop constraint settings_key_format;

alter table app.settings
  add constraint settings_key_format check (
    char_length(key) between 1 and 100
    and key ~ '^[A-Za-z][A-Za-z0-9_.-]*$'
  );

create or replace function private.api_collection_create(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_collection app.collections;
  v_idempotency_key text := nullif(p_input ->> 'idempotencyKey', '');
  v_has_appearance boolean := p_input ? 'appearance';
  v_has_learning_profile boolean := p_input ? 'learningProfile';
begin
  if v_has_appearance <> v_has_learning_profile then
    raise exception using errcode = '22023', message = 'COLLECTION_SETTINGS_INCOMPLETE';
  end if;

  if v_idempotency_key is not null then
    select * into v_collection
    from app.collections
    where owner_id = v_user_id
      and idempotency_key = v_idempotency_key;
    if found then
      return private.collection_json(v_collection);
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('collection-create:' || v_user_id::text, 0)
  );

  if (
    select count(*)
    from app.collections
    where owner_id = v_user_id
      and created_at >= statement_timestamp() - interval '1 day'
  ) >= 10 then
    raise exception using errcode = '54000', message = 'COLLECTION_DAILY_LIMIT';
  end if;

  insert into app.collections (owner_id, name, description, idempotency_key)
  values (
    v_user_id,
    private.normalize_surface(p_input ->> 'name'),
    nullif(left(btrim(p_input ->> 'description'), 1000), ''),
    v_idempotency_key
  )
  on conflict (owner_id, idempotency_key)
    where idempotency_key is not null
    do nothing
  returning * into v_collection;

  if not found then
    select * into v_collection
    from app.collections
    where owner_id = v_user_id
      and idempotency_key = v_idempotency_key;
    return private.collection_json(v_collection);
  end if;

  insert into app.collection_members (collection_id, user_id)
  values (v_collection.id, v_user_id);

  insert into app.collection_roles (
    collection_id,
    name,
    permissions,
    security_rank,
    is_managed,
    created_by
  )
  values (
    v_collection.id,
    '@everyone',
    '{}',
    0,
    true,
    v_user_id
  );

  if v_has_appearance then
    insert into app.settings (scope_type, collection_id, key, value)
    values
      ('collection', v_collection.id, 'appearance', p_input -> 'appearance'),
      ('collection', v_collection.id, 'learningProfile', p_input -> 'learningProfile');
  end if;

  return private.collection_json(v_collection);
end;
$$;

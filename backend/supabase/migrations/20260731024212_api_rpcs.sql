begin;

create or replace function private.all_permissions()
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select array[
    'manage_collection',
    'manage_roles',
    'manage_members',
    'manage_invites',
    'view_audit_log',
    'create_content',
    'edit_content',
    'delete_content',
    'create_lessons',
    'publish_lessons',
    'view_member_progress',
    'view_member_answers',
    'manage_collection_profiles'
  ]::text[];
$$;

create or replace function private.api_abuse_consume(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text := p_input ->> 'scope';
  v_abuse_key_hex text := lower(coalesce(p_input ->> 'abuseKey', ''));
  v_abuse_key bytea;
  v_limit integer;
  v_window_seconds integer;
  v_window_started_at timestamptz;
  v_count integer;
begin
  perform private.require_user();

  if v_abuse_key_hex !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_ABUSE_KEY';
  end if;

  select configured.request_limit, configured.window_seconds
  into v_limit, v_window_seconds
  from (
    values
      ('username_lookup'::text, 30::integer, 60::integer),
      ('invite_accept'::text, 10::integer, 3600::integer)
  ) as configured(scope, request_limit, window_seconds)
  where configured.scope = v_scope;

  if not found then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_SCOPE';
  end if;

  v_abuse_key := decode(v_abuse_key_hex, 'hex');
  v_window_started_at := to_timestamp(
    floor(extract(epoch from statement_timestamp()) / v_window_seconds)
      * v_window_seconds
  );

  insert into private.rate_limit_buckets (
    scope,
    abuse_key,
    window_started_at,
    request_count,
    expires_at
  )
  values (
    v_scope,
    v_abuse_key,
    v_window_started_at,
    1,
    v_window_started_at + make_interval(secs => v_window_seconds * 2)
  )
  on conflict (scope, abuse_key, window_started_at) do update
    set request_count = private.rate_limit_buckets.request_count + 1
    where private.rate_limit_buckets.request_count < v_limit
  returning request_count into v_count;

  if not found then
    raise exception using errcode = '54000', message = 'RATE_LIMITED';
  end if;

  return jsonb_build_object(
    'scope', v_scope,
    'limit', v_limit,
    'remaining', v_limit - v_count,
    'resetAt', v_window_started_at
      + make_interval(secs => v_window_seconds)
  );
end;
$$;

create or replace function private.effective_permissions(p_collection_id uuid)
returns text[]
language sql
stable
security definer
parallel safe
set search_path = ''
as $$
  select case
    when private.is_collection_owner(p_collection_id) then private.all_permissions()
    else coalesce((
      select array_agg(distinct permission order by permission)
      from app.collection_members as member
      join app.collection_roles as role
        on role.collection_id = member.collection_id
      left join app.collection_member_roles as assignment
        on assignment.collection_id = member.collection_id
       and assignment.user_id = member.user_id
       and assignment.role_id = role.id
      cross join lateral unnest(role.permissions) as permission_row(permission)
      where member.collection_id = p_collection_id
        and member.user_id = private.current_user_id()
        and (role.is_managed or assignment.role_id is not null)
    ), '{}'::text[])
  end;
$$;

create or replace function private.user_max_security_rank(
  p_collection_id uuid,
  p_user_id uuid
)
returns integer
language sql
stable
security definer
parallel safe
set search_path = ''
as $$
  select case
    when exists (
      select 1
      from app.collections
      where id = p_collection_id and owner_id = p_user_id
    ) then 2147483647
    else coalesce((
      select max(role.security_rank)
      from app.collection_member_roles as assignment
      join app.collection_roles as role
        on role.collection_id = assignment.collection_id
       and role.id = assignment.role_id
      where assignment.collection_id = p_collection_id
        and assignment.user_id = p_user_id
    ), 0)
  end;
$$;

create or replace function private.collection_json(p_collection app.collections)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_collection.id,
    'ownerId', p_collection.owner_id,
    'name', p_collection.name,
    'description', p_collection.description,
    'revision', p_collection.revision,
    'deletedAt', p_collection.deleted_at,
    'deleteAfter', p_collection.delete_after,
    'createdAt', p_collection.created_at,
    'updatedAt', p_collection.updated_at,
    'effectivePermissions', to_jsonb(private.effective_permissions(p_collection.id))
  );
$$;

create or replace function private.unit_snapshot(p_unit app.units)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'name', p_unit.name,
    'description', p_unit.description,
    'instructionOverride', p_unit.instruction_override,
    'languageCode', p_unit.language_code,
    'words', p_unit.words,
    'phrases', p_unit.phrases,
    'sentences', p_unit.sentences,
    'documents', p_unit.documents,
    'deletedAt', p_unit.deleted_at,
    'deleteAfter', p_unit.delete_after
  );
$$;

create or replace function private.unit_json(p_unit app.units)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_unit.id,
    'collectionId', p_unit.collection_id,
    'createdBy', p_unit.created_by,
    'name', p_unit.name,
    'description', p_unit.description,
    'instructionOverride', p_unit.instruction_override,
    'languageCode', p_unit.language_code,
    'words', p_unit.words,
    'phrases', p_unit.phrases,
    'sentences', p_unit.sentences,
    'documents', p_unit.documents,
    'revision', p_unit.revision,
    'deletedAt', p_unit.deleted_at,
    'deleteAfter', p_unit.delete_after,
    'createdAt', p_unit.created_at,
    'updatedAt', p_unit.updated_at
  );
$$;

create or replace function private.unit_summary_json(p_unit app.units)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_unit.id,
    'collectionId', p_unit.collection_id,
    'name', p_unit.name,
    'description', p_unit.description,
    'instructionOverride', p_unit.instruction_override,
    'languageCode', p_unit.language_code,
    'revision', p_unit.revision,
    'deletedAt', p_unit.deleted_at,
    'createdAt', p_unit.created_at,
    'updatedAt', p_unit.updated_at
  );
$$;

create or replace function private.lesson_json(p_lesson app.lessons)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_lesson.id,
    'collectionId', p_lesson.collection_id,
    'unitId', p_lesson.unit_id,
    'unitRevision', p_lesson.unit_revision,
    'ownerId', p_lesson.created_by,
    'status', p_lesson.status,
    'schemaVersion', p_lesson.schema_version,
    'title', p_lesson.title,
    'languageCode', p_lesson.language_code,
    'payload', p_lesson.payload,
    'revision', p_lesson.revision,
    'publishedAt', p_lesson.published_at,
    'publishedBy', p_lesson.published_by,
    'deletedAt', p_lesson.deleted_at,
    'createdAt', p_lesson.created_at,
    'updatedAt', p_lesson.updated_at
  );
$$;

create or replace function private.lesson_summary_json(p_lesson app.lessons)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_lesson.id,
    'collectionId', p_lesson.collection_id,
    'unitId', p_lesson.unit_id,
    'unitRevision', p_lesson.unit_revision,
    'ownerId', p_lesson.created_by,
    'status', p_lesson.status,
    'schemaVersion', p_lesson.schema_version,
    'title', p_lesson.title,
    'languageCode', p_lesson.language_code,
    'revision', p_lesson.revision,
    'publishedAt', p_lesson.published_at,
    'publishedBy', p_lesson.published_by,
    'deletedAt', p_lesson.deleted_at,
    'createdAt', p_lesson.created_at,
    'updatedAt', p_lesson.updated_at
  );
$$;

create or replace function private.encode_cursor(
  p_created_at timestamptz,
  p_id text
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select encode(
    convert_to(to_char(p_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z|' || p_id, 'UTF8'),
    'base64'
  );
$$;

create or replace function private.validate_username(p_username text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_username text := lower(btrim(coalesce(p_username, '')));
begin
  if char_length(v_username) not between 3 and 32
     or v_username !~ '^[a-z0-9._]+$'
     or strpos(v_username, '..') > 0 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_USERNAME';
  end if;
  return v_username;
end;
$$;

create or replace function private.api_get_me(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
  v_result jsonb;
begin
  select jsonb_build_object(
    'userId', auth_user.id,
    'email', auth_user.email,
    'emailVerified', auth_user.email_confirmed_at is not null,
    'onboardingComplete', auth_user.email_confirmed_at is not null
      and profile.username is not null,
    'deletion', jsonb_strip_nulls(jsonb_build_object(
      'status', case
        when profile.deletion_requested_at is null then 'none'
        else 'pending'
      end,
      'requestedAt', profile.deletion_requested_at,
      'scheduledFor', profile.delete_after
    )),
    'profile', jsonb_build_object(
      'username', profile.username,
      'displayName', profile.display_name,
      'avatarAssetId', profile.avatar_asset_id,
      'bio', profile.bio,
      'revision', profile.revision
    )
  )
  into v_result
  from auth.users as auth_user
  join app.profiles as profile on profile.user_id = auth_user.id
  where auth_user.id = v_user_id;

  if v_result is null then
    raise exception using errcode = 'P0001', message = 'PROFILE_NOT_FOUND';
  end if;

  return v_result;
end;
$$;

create or replace function private.api_username_availability(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
  v_username text := private.validate_username(p_input ->> 'username');
  v_available boolean;
begin
  select not exists (
    select 1
    from app.profiles
    where username = v_username
      and user_id <> v_user_id
  ) and not exists (
    select 1
    from app.username_reservations
    where username = v_username
      and (
        reservation_type = 'permanent'
        or (expires_at > statement_timestamp() and user_id <> v_user_id)
      )
  )
  into v_available;

  return jsonb_build_object(
    'username', v_username,
    'available', v_available
  );
end;
$$;

create or replace function private.api_change_username(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
  v_username text := private.validate_username(p_input ->> 'username');
  v_profile app.profiles;
begin
  select *
  into v_profile
  from app.profiles
  where user_id = v_user_id
  for update;

  if v_profile.api_locked_at is not null then
    raise exception using errcode = '42501', message = 'ACCOUNT_LOCKED';
  end if;

  if v_profile.username = v_username then
    return jsonb_build_object(
      'username', v_username,
      'revision', v_profile.revision,
      'usernameChangedAt', v_profile.username_changed_at
    );
  end if;

  if v_profile.username is not null
     and v_profile.username_changed_at > statement_timestamp() - interval '7 days' then
    raise exception using
      errcode = 'P0001',
      message = 'USERNAME_CHANGE_COOLDOWN';
  end if;

  if exists (
    select 1
    from app.profiles
    where username = v_username
      and user_id <> v_user_id
  ) or exists (
    select 1
    from app.username_reservations
    where username = v_username
      and (
        reservation_type = 'permanent'
        or (expires_at > statement_timestamp() and user_id <> v_user_id)
      )
  ) then
    raise exception using errcode = '23505', message = 'USERNAME_UNAVAILABLE';
  end if;

  if v_profile.username is not null then
    insert into app.username_reservations (
      username,
      reservation_type,
      user_id,
      expires_at,
      reason
    )
    values (
      v_profile.username,
      'released',
      v_user_id,
      statement_timestamp() + interval '30 days',
      'previous_username'
    )
    on conflict (username) do update
      set reservation_type = excluded.reservation_type,
          user_id = excluded.user_id,
          expires_at = excluded.expires_at,
          reason = excluded.reason,
          created_at = statement_timestamp()
      where app.username_reservations.reservation_type <> 'permanent';
  end if;

  delete from app.username_reservations
  where username = v_username
    and reservation_type = 'released'
    and user_id = v_user_id;

  update app.profiles
  set username = v_username,
      username_changed_at = case
        when v_profile.username is null then username_changed_at
        else statement_timestamp()
      end,
      revision = revision + 1
  where user_id = v_user_id
  returning * into v_profile;

  return jsonb_build_object(
    'username', v_profile.username,
    'revision', v_profile.revision,
    'usernameChangedAt', v_profile.username_changed_at
  );
end;
$$;

create or replace function private.api_update_profile(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
  v_profile app.profiles;
  v_expected_revision bigint := nullif(p_input ->> 'expectedRevision', '')::bigint;
begin
  select *
  into v_profile
  from app.profiles
  where user_id = v_user_id
  for update;

  if v_profile.api_locked_at is not null then
    raise exception using errcode = '42501', message = 'ACCOUNT_LOCKED';
  end if;

  if v_expected_revision is not null and v_profile.revision <> v_expected_revision then
    raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
  end if;

  if p_input ? 'avatarAssetId'
     and nullif(p_input ->> 'avatarAssetId', '') is not null then
    perform 1
    from app.file_assets
    where id = (p_input ->> 'avatarAssetId')::uuid
      and owner_id = v_user_id
      and collection_id is null
      and status = 'ready'
    for update;

    if not found then
      raise exception using errcode = '23503', message = 'AVATAR_ASSET_INVALID';
    end if;
  end if;

  update app.profiles
  set display_name = case
        when p_input ? 'displayName'
          then nullif(left(private.normalize_surface(p_input ->> 'displayName'), 64), '')
        else display_name
      end,
      avatar_asset_id = case
        when p_input ? 'avatarAssetId'
          then nullif(p_input ->> 'avatarAssetId', '')::uuid
        else avatar_asset_id
      end,
      bio = case
        when p_input ? 'bio'
          then nullif(left(btrim(p_input ->> 'bio'), 500), '')
        else bio
      end,
      revision = revision + 1
  where user_id = v_user_id
  returning * into v_profile;

  if p_input ? 'username'
     and private.validate_username(p_input ->> 'username') is distinct from v_profile.username then
    perform private.api_change_username(
      jsonb_build_object('username', p_input ->> 'username')
    );
    select * into v_profile from app.profiles where user_id = v_user_id;
  end if;

  return jsonb_build_object(
    'username', v_profile.username,
    'displayName', v_profile.display_name,
    'avatarAssetId', v_profile.avatar_asset_id,
    'bio', v_profile.bio,
    'revision', v_profile.revision,
    'updatedAt', v_profile.updated_at
  );
end;
$$;

create or replace function private.api_request_account_deletion(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
  v_profile app.profiles;
begin
  if exists (
    select 1
    from app.collections
    where owner_id = v_user_id
      and deleted_at is null
  ) then
    raise exception using
      errcode = '23514',
      message = 'OWNERSHIP_TRANSFER_REQUIRED';
  end if;

  update app.profiles
  set deletion_requested_at = coalesce(deletion_requested_at, statement_timestamp()),
      delete_after = coalesce(delete_after, statement_timestamp() + interval '30 days'),
      api_locked_at = coalesce(api_locked_at, statement_timestamp()),
      revision = revision + 1
  where user_id = v_user_id
  returning * into v_profile;

  return jsonb_build_object(
    'status', 'pending',
    'requestedAt', v_profile.deletion_requested_at,
    'scheduledFor', v_profile.delete_after
  );
end;
$$;

create or replace function private.api_cancel_account_deletion(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
  v_profile app.profiles;
begin
  select *
  into v_profile
  from app.profiles
  where user_id = v_user_id
  for update;

  if not found
     or v_profile.delete_after is null
     or v_profile.delete_after <= clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'DELETION_NOT_CANCELABLE';
  end if;

  update app.profiles
  set deletion_requested_at = null,
      delete_after = null,
      api_locked_at = null,
      revision = revision + 1
  where user_id = v_user_id;

  return jsonb_build_object('status', 'none');
end;
$$;

create or replace function private.api_collection_list(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_limit integer := least(greatest(coalesce((p_input ->> 'limit')::integer, 50), 1), 100);
  v_items jsonb;
  v_next_cursor text;
begin
  with rows as (
    select collection.*
    from app.collections as collection
    join app.collection_members as member
      on member.collection_id = collection.id
    where member.user_id = v_user_id
      and (
        coalesce((p_input ->> 'includeDeleted')::boolean, false)
        or collection.deleted_at is null
      )
      and (
        p_input ->> 'cursor' is null
        or (collection.created_at, collection.id::text) < (
          split_part(convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'), '|', 1)::timestamptz,
          split_part(convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'), '|', 2)
        )
      )
    order by collection.created_at desc, collection.id desc
    limit v_limit + 1
  ),
  page as (
    select *
    from rows
    order by created_at desc, id desc
    limit v_limit
  )
  select
    coalesce(jsonb_agg(private.collection_json(page) order by page.created_at desc, page.id desc), '[]'),
    case
      when (select count(*) from rows) > v_limit
      then (
        select private.encode_cursor(created_at, id::text)
        from page
        order by created_at asc, id asc
        limit 1
      )
      else null
    end
  into v_items, v_next_cursor
  from page;

  return jsonb_build_object('items', v_items, 'nextCursor', v_next_cursor);
exception
  when invalid_parameter_value or invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CURSOR';
end;
$$;

create or replace function private.api_collection_get(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_collection app.collections;
begin
  perform private.require_active_user();
  select * into v_collection
  from app.collections
  where id = (p_input ->> 'collectionId')::uuid;

  if not found or not private.is_collection_member(v_collection.id) then
    raise exception using errcode = 'P0001', message = 'COLLECTION_NOT_FOUND';
  end if;
  return private.collection_json(v_collection);
end;
$$;

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
begin
  if v_idempotency_key is not null then
    select * into v_collection
    from app.collections
    where owner_id = v_user_id
      and idempotency_key = v_idempotency_key;
    if found then
      return private.collection_json(v_collection);
    end if;
  end if;

  -- Serialize quota checks per owner so concurrent creates cannot overshoot.
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

  return private.collection_json(v_collection);
end;
$$;

create or replace function private.api_collection_update(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection app.collections;
  v_expected_revision bigint := (p_input ->> 'expectedRevision')::bigint;
begin
  perform private.require_active_user();
  select * into v_collection
  from app.collections
  where id = (p_input ->> 'collectionId')::uuid
  for update;

  if not found or not private.has_collection_permission(v_collection.id, 'manage_collection') then
    raise exception using errcode = '42501', message = 'COLLECTION_FORBIDDEN';
  end if;
  if v_collection.deleted_at is not null then
    raise exception using errcode = '23514', message = 'COLLECTION_DELETED';
  end if;
  if v_collection.revision is distinct from v_expected_revision then
    raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
  end if;

  update app.collections
  set name = coalesce(
        nullif(private.normalize_surface(p_input ->> 'name'), ''),
        name
      ),
      description = case
        when p_input ? 'description'
          then nullif(left(btrim(p_input ->> 'description'), 1000), '')
        else description
      end,
      revision = revision + 1
  where id = v_collection.id
  returning * into v_collection;

  return private.collection_json(v_collection);
end;
$$;

create or replace function private.api_collection_delete(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection app.collections;
begin
  perform private.require_active_user();
  select * into v_collection
  from app.collections
  where id = (p_input ->> 'collectionId')::uuid
  for update;

  if not found or not private.is_collection_owner(v_collection.id) then
    raise exception using errcode = '42501', message = 'OWNER_REQUIRED';
  end if;
  if v_collection.revision is distinct from (p_input ->> 'expectedRevision')::bigint then
    raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
  end if;

  update app.collections
  set deleted_at = coalesce(deleted_at, statement_timestamp()),
      delete_after = coalesce(delete_after, statement_timestamp() + interval '30 days'),
      revision = revision + 1
  where id = v_collection.id
  returning * into v_collection;

  return private.collection_json(v_collection);
end;
$$;

create or replace function private.api_collection_restore(
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
begin
  select * into v_collection
  from app.collections
  where id = (p_input ->> 'collectionId')::uuid
  for update;

  if not found or v_collection.owner_id <> v_user_id then
    raise exception using errcode = '42501', message = 'OWNER_REQUIRED';
  end if;
  if v_collection.delete_after is null
     or v_collection.delete_after <= statement_timestamp() then
    raise exception using errcode = 'P0001', message = 'COLLECTION_NOT_RESTORABLE';
  end if;
  if v_collection.revision is distinct from (p_input ->> 'expectedRevision')::bigint then
    raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
  end if;

  update app.collections
  set deleted_at = null,
      delete_after = null,
      revision = revision + 1
  where id = v_collection.id
  returning * into v_collection;

  return private.collection_json(v_collection);
end;
$$;

create or replace function private.api_collection_transfer(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_new_owner_id uuid := (p_input ->> 'newOwnerId')::uuid;
  v_collection app.collections;
begin
  select * into v_collection
  from app.collections
  where id = (p_input ->> 'collectionId')::uuid
  for update;

  if not found or v_collection.owner_id <> v_user_id then
    raise exception using errcode = '42501', message = 'OWNER_REQUIRED';
  end if;
  if v_collection.deleted_at is not null then
    raise exception using errcode = '23514', message = 'COLLECTION_DELETED';
  end if;
  if v_collection.revision is distinct from (p_input ->> 'expectedRevision')::bigint then
    raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
  end if;
  if not exists (
    select 1
    from app.collection_members
    where collection_id = v_collection.id and user_id = v_new_owner_id
  ) then
    raise exception using errcode = '23503', message = 'NEW_OWNER_MUST_BE_MEMBER';
  end if;

  update app.collections
  set owner_id = v_new_owner_id,
      revision = revision + 1
  where id = v_collection.id
  returning * into v_collection;

  return private.collection_json(v_collection);
end;
$$;

create or replace function private.api_collection_leave(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_collection_id uuid := (p_input ->> 'collectionId')::uuid;
begin
  if exists (
    select 1
    from app.collections
    where id = v_collection_id
      and owner_id = v_user_id
  ) then
    raise exception using errcode = '23514', message = 'OWNER_CANNOT_LEAVE';
  end if;

  delete from app.collection_members
  where collection_id = v_collection_id
    and user_id = v_user_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'MEMBERSHIP_NOT_FOUND';
  end if;

  return jsonb_build_object('left', true, 'collectionId', v_collection_id);
end;
$$;

create or replace function private.api_collection_member_list(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_collection_id uuid := (p_input ->> 'collectionId')::uuid;
  v_limit integer := least(greatest(coalesce((p_input ->> 'limit')::integer, 50), 1), 100);
  v_items jsonb;
begin
  perform private.require_active_user();
  if not private.is_collection_member(v_collection_id) then
    raise exception using errcode = '42501', message = 'COLLECTION_FORBIDDEN';
  end if;

  select coalesce(jsonb_agg(item order by joined_at desc, user_id desc), '[]')
  into v_items
  from (
    select
      member.joined_at,
      member.user_id,
      jsonb_build_object(
        'userId', member.user_id,
        'username', profile.username,
        'displayName', coalesce(collection_profile.display_name, profile.display_name),
        'avatarAssetId', coalesce(collection_profile.avatar_asset_id, profile.avatar_asset_id),
        'bio', coalesce(collection_profile.bio, profile.bio),
        'profileRevision', coalesce(collection_profile.revision, 0),
        'collectionProfile', case
          when collection_profile.user_id is null then null
          else jsonb_build_object(
            'displayName', collection_profile.display_name,
            'avatarAssetId', collection_profile.avatar_asset_id,
            'bio', collection_profile.bio,
            'revision', collection_profile.revision
          )
        end,
        'joinedAt', member.joined_at,
        'isOwner', collection.owner_id = member.user_id,
        'roleIds', coalesce((
          select jsonb_agg(assignment.role_id order by role.security_rank desc, assignment.role_id)
          from app.collection_member_roles as assignment
          join app.collection_roles as role
            on role.id = assignment.role_id
           and role.collection_id = assignment.collection_id
          where assignment.collection_id = member.collection_id
            and assignment.user_id = member.user_id
        ), '[]'::jsonb)
      ) as item
    from app.collection_members as member
    join app.collections as collection on collection.id = member.collection_id
    join app.profiles as profile on profile.user_id = member.user_id
    left join app.collection_profiles as collection_profile
      on collection_profile.collection_id = member.collection_id
     and collection_profile.user_id = member.user_id
    where member.collection_id = v_collection_id
      and (
        p_input ->> 'cursor' is null
        or (member.joined_at, member.user_id::text) < (
          split_part(
            convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'),
            '|',
            1
          )::timestamptz,
          split_part(
            convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'),
            '|',
            2
          )
        )
      )
    order by member.joined_at desc, member.user_id desc
    limit v_limit
  ) as members;

  return jsonb_build_object(
    'items', v_items,
    'nextCursor', case
      when jsonb_array_length(v_items) = v_limit
      then private.encode_cursor(
        (v_items -> (jsonb_array_length(v_items) - 1) ->> 'joinedAt')::timestamptz,
        v_items -> (jsonb_array_length(v_items) - 1) ->> 'userId'
      )
      else null
    end
  );
exception
  when invalid_parameter_value or invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CURSOR';
end;
$$;

create or replace function private.api_collection_member_remove(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_active_user();
  v_collection_id uuid := (p_input ->> 'collectionId')::uuid;
  v_target_id uuid := (p_input ->> 'userId')::uuid;
begin
  if not private.has_collection_permission(v_collection_id, 'manage_members') then
    raise exception using errcode = '42501', message = 'MISSING_PERMISSION';
  end if;
  if private.is_collection_owner(v_collection_id)
     and v_actor_id = v_target_id then
    raise exception using errcode = '23514', message = 'OWNER_CANNOT_LEAVE';
  end if;
  if exists (
    select 1 from app.collections
    where id = v_collection_id and owner_id = v_target_id
  ) then
    raise exception using errcode = '23514', message = 'OWNER_CANNOT_BE_REMOVED';
  end if;
  if private.user_max_security_rank(v_collection_id, v_target_id)
     >= private.user_max_security_rank(v_collection_id, v_actor_id) then
    raise exception using errcode = '42501', message = 'ROLE_HIERARCHY_VIOLATION';
  end if;

  delete from app.collection_members
  where collection_id = v_collection_id
    and user_id = v_target_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'MEMBERSHIP_NOT_FOUND';
  end if;

  return jsonb_build_object('removed', true, 'userId', v_target_id);
end;
$$;

create or replace function private.api_collection_profile_upsert(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_active_user();
  v_collection_id uuid := (p_input ->> 'collectionId')::uuid;
  v_user_id uuid := coalesce(nullif(p_input ->> 'userId', '')::uuid, v_actor_id);
  v_profile app.collection_profiles;
  v_existing app.collection_profiles;
  v_exists boolean;
  v_expected_revision bigint;
begin
  if not p_input ? 'expectedRevision'
     or jsonb_typeof(p_input -> 'expectedRevision') is distinct from 'number'
     or coalesce(p_input ->> 'expectedRevision', '') !~ '^(0|[1-9][0-9]*)$' then
    raise exception using errcode = '22023', message = 'EXPECTED_REVISION_REQUIRED';
  end if;
  v_expected_revision := (p_input ->> 'expectedRevision')::bigint;

  if not private.is_collection_member(v_collection_id)
     or (
       v_user_id <> v_actor_id
       and not private.has_collection_permission(v_collection_id, 'manage_collection_profiles')
     ) then
    raise exception using errcode = '42501', message = 'COLLECTION_PROFILE_FORBIDDEN';
  end if;
  perform 1
  from app.collection_members
  where collection_id = v_collection_id
    and user_id = v_user_id;
  if not found then
    raise exception using errcode = '42501', message = 'COLLECTION_PROFILE_FORBIDDEN';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'collection-profile:' || v_collection_id::text || ':' || v_user_id::text,
      0
    )
  );

  select * into v_existing
  from app.collection_profiles
  where collection_id = v_collection_id
    and user_id = v_user_id
  for update;
  v_exists := found;

  if (v_exists and v_existing.revision is distinct from v_expected_revision)
     or (not v_exists and v_expected_revision is distinct from 0) then
    raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
  end if;

  if p_input ? 'avatarAssetId'
     and nullif(p_input ->> 'avatarAssetId', '') is not null then
    perform 1
    from app.file_assets
    where id = (p_input ->> 'avatarAssetId')::uuid
      and status = 'ready'
      and owner_id = v_actor_id
      and (
        collection_id = v_collection_id
        or collection_id is null
      )
    for update;

    if not found then
      raise exception using errcode = '23503', message = 'AVATAR_ASSET_INVALID';
    end if;
  end if;

  insert into app.collection_profiles (
    collection_id,
    user_id,
    display_name,
    avatar_asset_id,
    bio
  )
  values (
    v_collection_id,
    v_user_id,
    nullif(left(private.normalize_surface(p_input ->> 'displayName'), 64), ''),
    nullif(p_input ->> 'avatarAssetId', '')::uuid,
    nullif(left(btrim(p_input ->> 'bio'), 500), '')
  )
  on conflict (collection_id, user_id) do update
    set display_name = case
          when p_input ? 'displayName' then excluded.display_name
          else app.collection_profiles.display_name
        end,
        avatar_asset_id = case
          when p_input ? 'avatarAssetId' then excluded.avatar_asset_id
          else app.collection_profiles.avatar_asset_id
        end,
        bio = case
          when p_input ? 'bio' then excluded.bio
          else app.collection_profiles.bio
        end,
        revision = app.collection_profiles.revision + 1
  returning * into v_profile;

  return jsonb_build_object(
    'collectionId', v_profile.collection_id,
    'userId', v_profile.user_id,
    'displayName', v_profile.display_name,
    'avatarAssetId', v_profile.avatar_asset_id,
    'bio', v_profile.bio,
    'revision', v_profile.revision,
    'updatedAt', v_profile.updated_at
  );
end;
$$;

create or replace function private.api_role_list(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_collection_id uuid := (p_input ->> 'collectionId')::uuid;
  v_limit integer := least(greatest(coalesce((p_input ->> 'limit')::integer, 50), 1), 100);
  v_items jsonb;
begin
  perform private.require_active_user();
  if not private.is_collection_member(v_collection_id) then
    raise exception using errcode = '42501', message = 'COLLECTION_FORBIDDEN';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', role.id,
      'collectionId', role.collection_id,
      'name', role.name,
      'color', role.color,
      'permissions', to_jsonb(role.permissions),
      'securityRank', role.security_rank,
      'isManaged', role.is_managed,
      'revision', role.revision,
      'createdAt', role.created_at,
      'updatedAt', role.updated_at
    )
    order by role.created_at desc, role.id desc
  ), '[]')
  into v_items
  from (
    select listed_role.*
    from app.collection_roles as listed_role
    where listed_role.collection_id = v_collection_id
      and (
        p_input ->> 'cursor' is null
        or (listed_role.created_at, listed_role.id::text) < (
          split_part(
            convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'),
            '|',
            1
          )::timestamptz,
          split_part(
            convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'),
            '|',
            2
          )
        )
      )
    order by listed_role.created_at desc, listed_role.id desc
    limit v_limit
  ) as role;

  return jsonb_build_object(
    'items', v_items,
    'nextCursor', case
      when jsonb_array_length(v_items) = v_limit
      then private.encode_cursor(
        (v_items -> (jsonb_array_length(v_items) - 1) ->> 'createdAt')::timestamptz,
        v_items -> (jsonb_array_length(v_items) - 1) ->> 'id'
      )
      else null
    end
  );
exception
  when invalid_parameter_value or invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CURSOR';
end;
$$;

create or replace function private.api_role_create(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_collection_id uuid := (p_input ->> 'collectionId')::uuid;
  v_permissions text[] := coalesce(
    array(select jsonb_array_elements_text(p_input -> 'permissions')),
    '{}'::text[]
  );
  v_rank integer := coalesce((p_input ->> 'securityRank')::integer, 1);
  v_role app.collection_roles;
  v_idempotency_key text := nullif(p_input ->> 'idempotencyKey', '');
begin
  if v_idempotency_key is not null then
    select * into v_role
    from app.collection_roles
    where collection_id = v_collection_id
      and created_by = v_user_id
      and idempotency_key = v_idempotency_key;
    if found then
      return jsonb_build_object(
        'id', v_role.id,
        'collectionId', v_role.collection_id,
        'name', v_role.name,
        'color', v_role.color,
        'permissions', to_jsonb(v_role.permissions),
        'securityRank', v_role.security_rank,
        'isManaged', v_role.is_managed,
        'revision', v_role.revision,
        'createdAt', v_role.created_at,
        'updatedAt', v_role.updated_at
      );
    end if;
  end if;

  if not private.has_collection_permission(v_collection_id, 'manage_roles') then
    raise exception using errcode = '42501', message = 'MISSING_PERMISSION';
  end if;
  if not private.valid_permissions(v_permissions) then
    raise exception using errcode = '22023', message = 'INVALID_PERMISSIONS';
  end if;
  if not private.is_collection_owner(v_collection_id)
     and not (
       v_permissions <@ private.effective_permissions(v_collection_id)
     ) then
    raise exception using errcode = '42501', message = 'ROLE_PERMISSION_ESCALATION';
  end if;
  if v_rank >= private.user_max_security_rank(v_collection_id, v_user_id) then
    raise exception using errcode = '42501', message = 'ROLE_HIERARCHY_VIOLATION';
  end if;

  insert into app.collection_roles (
    collection_id,
    name,
    color,
    permissions,
    security_rank,
    created_by,
    idempotency_key
  )
  values (
    v_collection_id,
    private.normalize_surface(p_input ->> 'name'),
    nullif(p_input ->> 'color', ''),
    v_permissions,
    v_rank,
    v_user_id,
    v_idempotency_key
  )
  on conflict (collection_id, created_by, idempotency_key)
    where idempotency_key is not null
    do nothing
  returning * into v_role;

  if not found then
    select * into v_role
    from app.collection_roles
    where collection_id = v_collection_id
      and created_by = v_user_id
      and idempotency_key = v_idempotency_key;
  end if;

  return jsonb_build_object(
    'id', v_role.id,
    'collectionId', v_role.collection_id,
    'name', v_role.name,
    'color', v_role.color,
    'permissions', to_jsonb(v_role.permissions),
    'securityRank', v_role.security_rank,
    'isManaged', v_role.is_managed,
    'revision', v_role.revision,
    'createdAt', v_role.created_at,
    'updatedAt', v_role.updated_at
  );
end;
$$;

create or replace function private.api_role_update(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_role app.collection_roles;
  v_permissions text[];
  v_rank integer;
begin
  select * into v_role
  from app.collection_roles
  where id = (p_input ->> 'roleId')::uuid
    and collection_id = (p_input ->> 'collectionId')::uuid
  for update;

  if not found or not private.has_collection_permission(v_role.collection_id, 'manage_roles') then
    raise exception using errcode = '42501', message = 'ROLE_FORBIDDEN';
  end if;
  if v_role.revision is distinct from (p_input ->> 'expectedRevision')::bigint then
    raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
  end if;
  if v_role.is_managed
     and not private.is_collection_owner(v_role.collection_id) then
    raise exception using errcode = '42501', message = 'MANAGED_ROLE_OWNER_REQUIRED';
  end if;
  if not v_role.is_managed
     and v_role.security_rank >= private.user_max_security_rank(v_role.collection_id, v_user_id) then
    raise exception using errcode = '42501', message = 'ROLE_HIERARCHY_VIOLATION';
  end if;

  v_permissions := case
    when p_input ? 'permissions'
      then array(select jsonb_array_elements_text(p_input -> 'permissions'))
    else v_role.permissions
  end;
  v_rank := case
    when p_input ? 'securityRank' then (p_input ->> 'securityRank')::integer
    else v_role.security_rank
  end;

  if not private.valid_permissions(v_permissions) then
    raise exception using errcode = '22023', message = 'INVALID_PERMISSIONS';
  end if;
  if not private.is_collection_owner(v_role.collection_id)
     and not (
       v_permissions <@ private.effective_permissions(v_role.collection_id)
     ) then
    raise exception using errcode = '42501', message = 'ROLE_PERMISSION_ESCALATION';
  end if;
  if not v_role.is_managed
     and v_rank >= private.user_max_security_rank(v_role.collection_id, v_user_id) then
    raise exception using errcode = '42501', message = 'ROLE_HIERARCHY_VIOLATION';
  end if;

  update app.collection_roles
  set name = case
        when is_managed then name
        when p_input ? 'name'
          then private.normalize_surface(p_input ->> 'name')
        else name
      end,
      color = case
        when p_input ? 'color' then nullif(p_input ->> 'color', '')
        else color
      end,
      permissions = v_permissions,
      security_rank = case when is_managed then security_rank else v_rank end,
      revision = revision + 1
  where id = v_role.id
  returning * into v_role;

  return jsonb_build_object(
    'id', v_role.id,
    'collectionId', v_role.collection_id,
    'name', v_role.name,
    'color', v_role.color,
    'permissions', to_jsonb(v_role.permissions),
    'securityRank', v_role.security_rank,
    'isManaged', v_role.is_managed,
    'revision', v_role.revision,
    'createdAt', v_role.created_at,
    'updatedAt', v_role.updated_at
  );
end;
$$;

create or replace function private.api_role_delete(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_role app.collection_roles;
begin
  select * into v_role
  from app.collection_roles
  where id = (p_input ->> 'roleId')::uuid
    and collection_id = (p_input ->> 'collectionId')::uuid
  for update;

  if not found or not private.has_collection_permission(v_role.collection_id, 'manage_roles') then
    raise exception using errcode = '42501', message = 'ROLE_FORBIDDEN';
  end if;
  if v_role.is_managed then
    raise exception using errcode = '23514', message = 'MANAGED_ROLE_CANNOT_BE_DELETED';
  end if;
  if v_role.security_rank >= private.user_max_security_rank(v_role.collection_id, v_user_id) then
    raise exception using errcode = '42501', message = 'ROLE_HIERARCHY_VIOLATION';
  end if;

  delete from app.collection_roles where id = v_role.id;
  return jsonb_build_object('deleted', true, 'roleId', v_role.id);
end;
$$;

create or replace function private.api_role_assign(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_active_user();
  v_collection_id uuid := (p_input ->> 'collectionId')::uuid;
  v_user_id uuid := (p_input ->> 'userId')::uuid;
  v_role app.collection_roles;
begin
  select * into v_role
  from app.collection_roles
  where id = (p_input ->> 'roleId')::uuid
    and collection_id = v_collection_id;

  if not found or v_role.is_managed
     or not private.has_collection_permission(v_collection_id, 'manage_roles') then
    raise exception using errcode = '42501', message = 'ROLE_FORBIDDEN';
  end if;
  if v_role.security_rank >= private.user_max_security_rank(v_collection_id, v_actor_id)
     or private.user_max_security_rank(v_collection_id, v_user_id)
        >= private.user_max_security_rank(v_collection_id, v_actor_id) then
    raise exception using errcode = '42501', message = 'ROLE_HIERARCHY_VIOLATION';
  end if;
  if not private.is_collection_owner(v_collection_id)
     and not (
       v_role.permissions <@ private.effective_permissions(v_collection_id)
     ) then
    raise exception using errcode = '42501', message = 'ROLE_PERMISSION_ESCALATION';
  end if;
  if not exists (
    select 1 from app.collection_members
    where collection_id = v_collection_id and user_id = v_user_id
  ) then
    raise exception using errcode = '23503', message = 'MEMBER_NOT_FOUND';
  end if;

  insert into app.collection_member_roles (
    collection_id,
    user_id,
    role_id,
    assigned_by
  )
  values (v_collection_id, v_user_id, v_role.id, v_actor_id)
  on conflict do nothing;

  return jsonb_build_object(
    'assigned', true,
    'roleId', v_role.id,
    'userId', v_user_id
  );
end;
$$;

create or replace function private.api_role_unassign(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_active_user();
  v_collection_id uuid := (p_input ->> 'collectionId')::uuid;
  v_user_id uuid := (p_input ->> 'userId')::uuid;
  v_role app.collection_roles;
begin
  select * into v_role
  from app.collection_roles
  where id = (p_input ->> 'roleId')::uuid
    and collection_id = v_collection_id;

  if not found or v_role.is_managed
     or not private.has_collection_permission(v_collection_id, 'manage_roles') then
    raise exception using errcode = '42501', message = 'ROLE_FORBIDDEN';
  end if;
  if v_role.security_rank >= private.user_max_security_rank(v_collection_id, v_actor_id)
     or private.user_max_security_rank(v_collection_id, v_user_id)
        >= private.user_max_security_rank(v_collection_id, v_actor_id) then
    raise exception using errcode = '42501', message = 'ROLE_HIERARCHY_VIOLATION';
  end if;

  delete from app.collection_member_roles
  where collection_id = v_collection_id
    and user_id = v_user_id
    and role_id = v_role.id;

  return jsonb_build_object(
    'assigned', false,
    'roleId', v_role.id,
    'userId', v_user_id
  );
end;
$$;

create or replace function private.invite_json(p_invite app.collection_invites)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_invite.id,
    'collectionId', p_invite.collection_id,
    'tokenHint', p_invite.token_hint,
    'expiresAt', p_invite.expires_at,
    'maxUses', p_invite.max_uses,
    'usesCount', p_invite.uses_count,
    'revokedAt', p_invite.revoked_at,
    'revision', p_invite.revision,
    'roleIds', coalesce((
      select jsonb_agg(link.role_id order by link.role_id)
      from app.collection_invite_roles as link
      where link.invite_id = p_invite.id
    ), '[]'::jsonb),
    'createdAt', p_invite.created_at
  );
$$;

create or replace function private.api_invite_list(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_collection_id uuid := (p_input ->> 'collectionId')::uuid;
  v_limit integer := least(greatest(coalesce((p_input ->> 'limit')::integer, 50), 1), 100);
  v_items jsonb;
begin
  perform private.require_active_user();
  if not private.has_collection_permission(v_collection_id, 'manage_invites') then
    raise exception using errcode = '42501', message = 'MISSING_PERMISSION';
  end if;

  select coalesce(jsonb_agg(private.invite_json(invite)
    order by invite.created_at desc, invite.id desc), '[]')
  into v_items
  from (
    select listed_invite.*
    from app.collection_invites as listed_invite
    where listed_invite.collection_id = v_collection_id
      and (
        p_input ->> 'cursor' is null
        or (listed_invite.created_at, listed_invite.id::text) < (
          split_part(
            convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'),
            '|',
            1
          )::timestamptz,
          split_part(
            convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'),
            '|',
            2
          )
        )
      )
    order by listed_invite.created_at desc, listed_invite.id desc
    limit v_limit
  ) as invite;

  return jsonb_build_object(
    'items', v_items,
    'nextCursor', case
      when jsonb_array_length(v_items) = v_limit
      then private.encode_cursor(
        (v_items -> (jsonb_array_length(v_items) - 1) ->> 'createdAt')::timestamptz,
        v_items -> (jsonb_array_length(v_items) - 1) ->> 'id'
      )
      else null
    end
  );
exception
  when invalid_parameter_value or invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CURSOR';
end;
$$;

create or replace function private.api_invite_create(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_collection_id uuid := (p_input ->> 'collectionId')::uuid;
  v_role_id uuid;
  v_invite app.collection_invites;
  v_idempotency_key text := nullif(p_input ->> 'idempotencyKey', '');
begin
  if not private.has_collection_permission(v_collection_id, 'manage_invites') then
    raise exception using errcode = '42501', message = 'MISSING_PERMISSION';
  end if;

  if v_idempotency_key is not null then
    select * into v_invite
    from app.collection_invites
    where collection_id = v_collection_id
      and created_by = v_user_id
      and idempotency_key = v_idempotency_key;
    if found then
      return private.invite_json(v_invite);
    end if;
  end if;

  -- Serialize quota checks per collection so concurrent creates cannot overshoot.
  perform 1
  from app.collections
  where id = v_collection_id
  for update;

  if (
    select count(*)
    from app.collection_invites
    where collection_id = v_collection_id
      and created_at >= statement_timestamp() - interval '1 day'
  ) >= 50 then
    raise exception using errcode = '54000', message = 'INVITE_DAILY_LIMIT';
  end if;

  insert into app.collection_invites (
    collection_id,
    token_hash,
    token_hint,
    created_by,
    idempotency_key,
    expires_at,
    max_uses
  )
  values (
    v_collection_id,
    decode(p_input ->> 'tokenHash', 'hex'),
    nullif(p_input ->> 'tokenHint', ''),
    v_user_id,
    v_idempotency_key,
    nullif(p_input ->> 'expiresAt', '')::timestamptz,
    nullif(p_input ->> 'maxUses', '')::integer
  )
  on conflict (collection_id, created_by, idempotency_key)
    where idempotency_key is not null
    do nothing
  returning * into v_invite;

  if not found then
    select * into v_invite
    from app.collection_invites
    where collection_id = v_collection_id
      and created_by = v_user_id
      and idempotency_key = v_idempotency_key;
    return private.invite_json(v_invite);
  end if;

  for v_role_id in
    select value::uuid
    from jsonb_array_elements_text(coalesce(p_input -> 'roleIds', '[]'::jsonb))
  loop
    if not exists (
      select 1
      from app.collection_roles
      where id = v_role_id
        and collection_id = v_collection_id
        and not is_managed
        and security_rank < private.user_max_security_rank(v_collection_id, v_user_id)
        and (
          private.is_collection_owner(v_collection_id)
          or permissions <@ private.effective_permissions(v_collection_id)
        )
    ) then
      raise exception using errcode = '42501', message = 'INVITE_ROLE_FORBIDDEN';
    end if;

    insert into app.collection_invite_roles (invite_id, collection_id, role_id)
    values (v_invite.id, v_collection_id, v_role_id);
  end loop;

  return private.invite_json(v_invite);
end;
$$;

create or replace function private.api_invite_preview(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_invite app.collection_invites;
  v_collection app.collections;
begin
  perform private.require_active_user();
  select * into v_invite
  from app.collection_invites
  where token_hash = decode(p_input ->> 'tokenHash', 'hex');

  if not found
     or v_invite.revoked_at is not null
     or (v_invite.expires_at is not null and v_invite.expires_at <= statement_timestamp())
     or (v_invite.max_uses is not null and v_invite.uses_count >= v_invite.max_uses) then
    raise exception using errcode = 'P0001', message = 'INVITE_INVALID';
  end if;

  select * into v_collection
  from app.collections
  where id = v_invite.collection_id and deleted_at is null;

  if not found then
    raise exception using errcode = 'P0001', message = 'INVITE_INVALID';
  end if;

  return jsonb_build_object(
    'inviteId', v_invite.id,
    'collection', jsonb_build_object(
      'id', v_collection.id,
      'name', v_collection.name,
      'description', v_collection.description
    ),
    'expiresAt', v_invite.expires_at,
    'remainingUses', case
      when v_invite.max_uses is null then null
      else v_invite.max_uses - v_invite.uses_count
    end
  );
end;
$$;

create or replace function private.api_invite_accept(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_invite app.collection_invites;
  v_collection app.collections;
  v_existing_member app.collection_members;
  v_idempotency_key text := nullif(p_input ->> 'idempotencyKey', '');
  v_inserted_count integer := 0;
begin
  if v_idempotency_key is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'invite-accept:' || v_user_id::text || ':' || v_idempotency_key,
      0
    )
  );

  select * into v_invite
  from app.collection_invites
  where token_hash = decode(p_input ->> 'tokenHash', 'hex')
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'INVITE_INVALID';
  end if;

  select * into v_collection
  from app.collections
  where id = v_invite.collection_id and deleted_at is null
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'INVITE_INVALID';
  end if;

  select * into v_existing_member
  from app.collection_members
  where user_id = v_user_id
    and accept_idempotency_key = v_idempotency_key;
  if found then
    if v_existing_member.accepted_invite_id is distinct from v_invite.id then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return private.collection_json(v_collection);
  end if;

  if exists (
    select 1
    from app.collection_members
    where collection_id = v_invite.collection_id
      and user_id = v_user_id
  ) then
    return private.collection_json(v_collection);
  end if;

  if v_invite.revoked_at is not null
     or (v_invite.expires_at is not null and v_invite.expires_at <= statement_timestamp())
     or (v_invite.max_uses is not null and v_invite.uses_count >= v_invite.max_uses) then
    raise exception using errcode = 'P0001', message = 'INVITE_INVALID';
  end if;

  insert into app.collection_members (
    collection_id,
    user_id,
    invited_by,
    accepted_invite_id,
    accept_idempotency_key
  )
  values (
    v_invite.collection_id,
    v_user_id,
    v_invite.created_by,
    v_invite.id,
    v_idempotency_key
  )
  on conflict do nothing;
  get diagnostics v_inserted_count = row_count;

  if v_inserted_count > 0 then
    insert into app.collection_member_roles (
      collection_id,
      user_id,
      role_id,
      assigned_by
    )
    select
      link.collection_id,
      v_user_id,
      link.role_id,
      v_invite.created_by
    from app.collection_invite_roles as link
    where link.invite_id = v_invite.id
    on conflict do nothing;

    update app.collection_invites
    set uses_count = uses_count + 1,
        revision = revision + 1
    where id = v_invite.id;
  end if;

  return private.collection_json(v_collection);
end;
$$;

create or replace function private.api_invite_revoke(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite app.collection_invites;
begin
  perform private.require_active_user();
  select * into v_invite
  from app.collection_invites
  where id = (p_input ->> 'inviteId')::uuid
    and collection_id = (p_input ->> 'collectionId')::uuid
  for update;

  if not found or not private.has_collection_permission(v_invite.collection_id, 'manage_invites') then
    raise exception using errcode = '42501', message = 'INVITE_FORBIDDEN';
  end if;

  update app.collection_invites
  set revoked_at = coalesce(revoked_at, statement_timestamp()),
      revision = revision + 1
  where id = v_invite.id
  returning * into v_invite;

  return private.invite_json(v_invite);
end;
$$;

create or replace function private.api_settings_get(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_scope_type text := coalesce(p_input ->> 'scopeType', p_input ->> 'scope');
  v_collection_id uuid := nullif(p_input ->> 'collectionId', '')::uuid;
  v_target_user_id uuid := coalesce(nullif(p_input ->> 'userId', '')::uuid, v_user_id);
  v_items jsonb;
begin
  if v_scope_type not in ('user', 'collection', 'collection_user') then
    raise exception using errcode = '22023', message = 'INVALID_SETTINGS_SCOPE';
  end if;
  if v_scope_type = 'user' and v_target_user_id <> v_user_id then
    raise exception using errcode = '42501', message = 'SETTINGS_FORBIDDEN';
  elsif v_scope_type = 'collection'
        and not private.is_collection_member(v_collection_id) then
    raise exception using errcode = '42501', message = 'SETTINGS_FORBIDDEN';
  elsif v_scope_type = 'collection_user'
        and v_target_user_id <> v_user_id
        and not private.has_collection_permission(v_collection_id, 'manage_members') then
    raise exception using errcode = '42501', message = 'SETTINGS_FORBIDDEN';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'key', setting.key,
    'value', setting.value,
    'revision', setting.revision,
    'updatedAt', setting.updated_at
  ) order by setting.key), '[]')
  into v_items
  from app.settings as setting
  where setting.scope_type = v_scope_type
    and setting.user_id is not distinct from case
      when v_scope_type in ('user', 'collection_user') then v_target_user_id
      else null
    end
    and setting.collection_id is not distinct from case
      when v_scope_type in ('collection', 'collection_user') then v_collection_id
      else null
    end
    and (p_input ->> 'key' is null or setting.key = p_input ->> 'key');

  return jsonb_build_object('items', v_items);
end;
$$;

create or replace function private.api_settings_upsert(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_scope_type text := coalesce(p_input ->> 'scopeType', p_input ->> 'scope');
  v_collection_id uuid := nullif(p_input ->> 'collectionId', '')::uuid;
  v_target_user_id uuid := case
    when v_scope_type in ('user', 'collection_user') then v_user_id
    else null
  end;
  v_setting app.settings;
  v_expected bigint := nullif(p_input ->> 'expectedRevision', '')::bigint;
begin
  if v_scope_type = 'collection'
     and not private.has_collection_permission(v_collection_id, 'manage_collection') then
    raise exception using errcode = '42501', message = 'SETTINGS_FORBIDDEN';
  elsif v_scope_type = 'collection_user'
        and not private.is_collection_member(v_collection_id) then
    raise exception using errcode = '42501', message = 'SETTINGS_FORBIDDEN';
  elsif v_scope_type not in ('user', 'collection', 'collection_user') then
    raise exception using errcode = '22023', message = 'INVALID_SETTINGS_SCOPE';
  end if;

  select * into v_setting
  from app.settings
  where scope_type = v_scope_type
    and user_id is not distinct from v_target_user_id
    and collection_id is not distinct from v_collection_id
    and key = p_input ->> 'key'
  for update;

  if found then
    if v_expected is null or v_setting.revision <> v_expected then
      raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
    end if;
    update app.settings
    set value = p_input -> 'value',
        revision = revision + 1
    where id = v_setting.id
    returning * into v_setting;
  else
    if v_expected is not null and v_expected <> 0 then
      raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
    end if;
    insert into app.settings (
      scope_type,
      user_id,
      collection_id,
      key,
      value
    )
    values (
      v_scope_type,
      v_target_user_id,
      v_collection_id,
      p_input ->> 'key',
      p_input -> 'value'
    )
    returning * into v_setting;
  end if;

  return jsonb_build_object(
    'key', v_setting.key,
    'value', v_setting.value,
    'revision', v_setting.revision,
    'updatedAt', v_setting.updated_at
  );
end;
$$;

create or replace function private.api_settings_delete(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_scope_type text := coalesce(p_input ->> 'scopeType', p_input ->> 'scope');
  v_collection_id uuid := nullif(p_input ->> 'collectionId', '')::uuid;
  v_target_user_id uuid := case
    when v_scope_type in ('user', 'collection_user') then v_user_id
    else null
  end;
begin
  if v_scope_type = 'collection'
     and not private.has_collection_permission(v_collection_id, 'manage_collection') then
    raise exception using errcode = '42501', message = 'SETTINGS_FORBIDDEN';
  elsif v_scope_type = 'collection_user'
        and not private.is_collection_member(v_collection_id) then
    raise exception using errcode = '42501', message = 'SETTINGS_FORBIDDEN';
  end if;

  delete from app.settings
  where scope_type = v_scope_type
    and user_id is not distinct from v_target_user_id
    and collection_id is not distinct from v_collection_id
    and key = p_input ->> 'key'
    and revision = (p_input ->> 'expectedRevision')::bigint;

  if not found then
    raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
  end if;
  return jsonb_build_object('deleted', true, 'key', p_input ->> 'key');
end;
$$;

create or replace function private.api_audit_list(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_collection_id uuid := (p_input ->> 'collectionId')::uuid;
  v_limit integer := least(greatest(coalesce((p_input ->> 'limit')::integer, 50), 1), 100);
  v_items jsonb;
begin
  perform private.require_active_user();
  if not private.has_collection_permission(v_collection_id, 'view_audit_log') then
    raise exception using errcode = '42501', message = 'MISSING_PERMISSION';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', log.id,
    'collectionId', log.collection_id,
    'actorUserId', log.actor_user_id,
    'action', log.action,
    'targetType', log.target_type,
    'targetId', log.target_id,
    'metadata', log.metadata,
    'createdAt', log.created_at
  ) order by log.created_at desc, log.id desc), '[]')
  into v_items
  from (
    select *
    from app.collection_audit_logs
    where collection_id = v_collection_id
      and (
        p_input ->> 'cursor' is null
        or (created_at, id) < (
          split_part(
            convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'),
            '|',
            1
          )::timestamptz,
          split_part(
            convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'),
            '|',
            2
          )::bigint
        )
      )
    order by created_at desc, id desc
    limit v_limit
  ) as log;

  return jsonb_build_object(
    'items', v_items,
    'nextCursor', case
      when jsonb_array_length(v_items) = v_limit
      then private.encode_cursor(
        (v_items -> (jsonb_array_length(v_items) - 1) ->> 'createdAt')::timestamptz,
        v_items -> (jsonb_array_length(v_items) - 1) ->> 'id'
      )
      else null
    end
  );
exception
  when invalid_parameter_value or invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CURSOR';
end;
$$;

create or replace function private.lesson_payload_is_valid(
  p_unit_snapshot jsonb,
  p_payload jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_category text;
  v_question jsonb;
  v_question_id text;
  v_question_ids text[] := '{}';
  v_encountered jsonb;
  v_assessed jsonb;
  v_target text;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' then
    return false;
  end if;
  if p_payload ->> 'schemaVersion' is distinct from '8' then
    return false;
  end if;
  if jsonb_typeof(p_payload -> 'questions') is distinct from 'array' then
    return false;
  end if;
  if jsonb_array_length(p_payload -> 'questions') = 0 then
    return false;
  end if;

  for v_question in
    select value
    from jsonb_array_elements(p_payload -> 'questions')
  loop
    v_question_id := coalesce(
      v_question ->> 'questionId',
      v_question ->> 'id',
      ''
    );
    if jsonb_typeof(v_question) is distinct from 'object'
       or v_question_id = ''
       or char_length(v_question_id) > 128
       or jsonb_typeof(v_question -> 'tracking') is distinct from 'object'
       or jsonb_typeof(v_question #> '{tracking,encountered}')
            is distinct from 'object'
       or jsonb_typeof(v_question #> '{tracking,assessed}')
            is distinct from 'object'
       or v_question_id = any(v_question_ids) then
      return false;
    end if;

    v_question_ids := array_append(v_question_ids, v_question_id);

    foreach v_category in array array['words', 'phrases', 'sentences']
    loop
      v_encountered := v_question
        #> array['tracking', 'encountered', v_category];
      v_assessed := v_question
        #> array['tracking', 'assessed', v_category];

      if not private.is_normalized_unique_string_array(v_encountered)
         or not private.is_normalized_unique_string_array(v_assessed)
         or not (v_assessed <@ v_encountered) then
        return false;
      end if;

      for v_target in
        select value
        from jsonb_array_elements_text(v_encountered)
      loop
        if not exists (
          select 1
          from jsonb_array_elements(p_unit_snapshot -> v_category) as unit_term(value)
          where private.term_surface(unit_term.value) = v_target
        ) then
          return false;
        end if;
      end loop;
    end loop;
  end loop;

  return true;
end;
$$;

create or replace function private.api_unit_list(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_collection_id uuid := (p_input ->> 'collectionId')::uuid;
  v_limit integer := least(greatest(coalesce((p_input ->> 'limit')::integer, 50), 1), 100);
  v_items jsonb;
begin
  perform private.require_active_user();
  if not private.is_collection_member(v_collection_id) then
    raise exception using errcode = '42501', message = 'COLLECTION_FORBIDDEN';
  end if;

  select coalesce(jsonb_agg(private.unit_summary_json(unit)
    order by unit.updated_at desc, unit.id desc), '[]')
  into v_items
  from (
    select *
    from app.units
    where collection_id = v_collection_id
      and (
        coalesce((p_input ->> 'includeDeleted')::boolean, false)
        or deleted_at is null
      )
      and (
        p_input ->> 'cursor' is null
        or (updated_at, id::text) < (
          split_part(convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'), '|', 1)::timestamptz,
          split_part(convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'), '|', 2)
        )
      )
    order by updated_at desc, id desc
    limit v_limit
  ) as unit;

  return jsonb_build_object(
    'items', v_items,
    'nextCursor', case
      when jsonb_array_length(v_items) = v_limit
      then private.encode_cursor(
        (v_items -> (jsonb_array_length(v_items) - 1) ->> 'updatedAt')::timestamptz,
        v_items -> (jsonb_array_length(v_items) - 1) ->> 'id'
      )
      else null
    end
  );
exception
  when invalid_parameter_value or invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CURSOR';
end;
$$;

create or replace function private.api_unit_get(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_unit app.units;
begin
  perform private.require_active_user();
  select * into v_unit
  from app.units
  where id = (p_input ->> 'unitId')::uuid;

  if not found or not private.is_collection_member(v_unit.collection_id) then
    raise exception using errcode = 'P0001', message = 'UNIT_NOT_FOUND';
  end if;
  return private.unit_json(v_unit);
end;
$$;

create or replace function private.api_unit_create(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_collection_id uuid := nullif(p_input ->> 'collectionId', '')::uuid;
  v_unit app.units;
  v_idempotency_key text := nullif(p_input ->> 'idempotencyKey', '');
begin
  if not private.has_collection_permission(v_collection_id, 'create_content') then
    raise exception using errcode = '42501', message = 'MISSING_PERMISSION';
  end if;

  if v_idempotency_key is not null then
    select * into v_unit
    from app.units
    where collection_id = v_collection_id
      and created_by = v_user_id
      and idempotency_key = v_idempotency_key;
    if found then
      return private.unit_json(v_unit);
    end if;
  end if;

  insert into app.units (
    collection_id,
    created_by,
    idempotency_key,
    name,
    description,
    instruction_override,
    language_code,
    words,
    phrases,
    sentences,
    documents
  )
  values (
    v_collection_id,
    v_user_id,
    v_idempotency_key,
    private.normalize_surface(p_input ->> 'name'),
    nullif(private.normalize_prose(p_input ->> 'description'), ''),
    nullif(private.normalize_prose(p_input ->> 'instructionOverride'), ''),
    p_input ->> 'languageCode',
    coalesce(p_input -> 'words', '[]'),
    coalesce(p_input -> 'phrases', '[]'),
    coalesce(p_input -> 'sentences', '[]'),
    coalesce(p_input -> 'documents', '[]')
  )
  on conflict (collection_id, created_by, idempotency_key)
    where idempotency_key is not null
    do nothing
  returning * into v_unit;

  if not found then
    select * into v_unit
    from app.units
    where collection_id = v_collection_id
      and created_by = v_user_id
      and idempotency_key = v_idempotency_key;
    return private.unit_json(v_unit);
  end if;

  insert into app.unit_revisions (
    unit_id,
    collection_id,
    revision,
    snapshot,
    created_by,
    action
  )
  values (
    v_unit.id,
    v_unit.collection_id,
    v_unit.revision,
    private.unit_snapshot(v_unit),
    v_user_id,
    'created'
  );

  return private.unit_json(v_unit);
end;
$$;

create or replace function private.api_unit_update(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_unit app.units;
begin
  if not (
    p_input ? 'words'
    and p_input ? 'phrases'
    and p_input ? 'sentences'
    and p_input ? 'documents'
  ) then
    raise exception using errcode = '22023', message = 'UNIT_CONTENT_REPLACEMENT_REQUIRED';
  end if;

  select * into v_unit
  from app.units
  where id = (p_input ->> 'unitId')::uuid
  for update;

  if not found or not private.has_collection_permission(v_unit.collection_id, 'edit_content') then
    raise exception using errcode = '42501', message = 'UNIT_FORBIDDEN';
  end if;
  if v_unit.deleted_at is not null then
    raise exception using errcode = '23514', message = 'UNIT_DELETED';
  end if;
  if v_unit.revision is distinct from (p_input ->> 'expectedRevision')::bigint then
    raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
  end if;

  update app.units
  set name = coalesce(
        nullif(private.normalize_surface(p_input ->> 'name'), ''),
        name
      ),
      description = case
        when p_input ? 'description'
          then nullif(private.normalize_prose(p_input ->> 'description'), '')
        else description
      end,
      instruction_override = case
        when p_input ? 'instructionOverride'
          then nullif(private.normalize_prose(p_input ->> 'instructionOverride'), '')
        else instruction_override
      end,
      language_code = coalesce(p_input ->> 'languageCode', language_code),
      words = p_input -> 'words',
      phrases = p_input -> 'phrases',
      sentences = p_input -> 'sentences',
      documents = p_input -> 'documents',
      revision = revision + 1
  where id = v_unit.id
  returning * into v_unit;

  insert into app.unit_revisions (
    unit_id,
    collection_id,
    revision,
    snapshot,
    created_by,
    action
  )
  values (
    v_unit.id,
    v_unit.collection_id,
    v_unit.revision,
    private.unit_snapshot(v_unit),
    v_user_id,
    'updated'
  );

  return private.unit_json(v_unit);
end;
$$;

create or replace function private.api_unit_delete(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_unit app.units;
begin
  select * into v_unit
  from app.units
  where id = (p_input ->> 'unitId')::uuid
  for update;

  if not found or not private.has_collection_permission(v_unit.collection_id, 'delete_content') then
    raise exception using errcode = '42501', message = 'UNIT_FORBIDDEN';
  end if;
  if v_unit.revision is distinct from (p_input ->> 'expectedRevision')::bigint then
    raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
  end if;

  update app.units
  set deleted_at = coalesce(deleted_at, statement_timestamp()),
      delete_after = coalesce(delete_after, statement_timestamp() + interval '30 days'),
      revision = revision + 1
  where id = v_unit.id
  returning * into v_unit;

  insert into app.unit_revisions (
    unit_id, collection_id, revision, snapshot, created_by, action
  )
  values (
    v_unit.id,
    v_unit.collection_id,
    v_unit.revision,
    private.unit_snapshot(v_unit),
    v_user_id,
    'deleted'
  );

  return private.unit_json(v_unit);
end;
$$;

create or replace function private.api_unit_restore(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_unit app.units;
begin
  select * into v_unit
  from app.units
  where id = (p_input ->> 'unitId')::uuid
  for update;

  if not found or not private.has_collection_permission(v_unit.collection_id, 'edit_content') then
    raise exception using errcode = '42501', message = 'UNIT_FORBIDDEN';
  end if;
  if v_unit.delete_after is null or v_unit.delete_after <= statement_timestamp() then
    raise exception using errcode = 'P0001', message = 'UNIT_NOT_RESTORABLE';
  end if;
  if v_unit.revision is distinct from (p_input ->> 'expectedRevision')::bigint then
    raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
  end if;

  update app.units
  set deleted_at = null,
      delete_after = null,
      revision = revision + 1
  where id = v_unit.id
  returning * into v_unit;

  insert into app.unit_revisions (
    unit_id, collection_id, revision, snapshot, created_by, action
  )
  values (
    v_unit.id,
    v_unit.collection_id,
    v_unit.revision,
    private.unit_snapshot(v_unit),
    v_user_id,
    'undeleted'
  );

  return private.unit_json(v_unit);
end;
$$;

create or replace function private.api_unit_revision_list(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_unit app.units;
  v_items jsonb;
  v_limit integer := least(greatest(coalesce((p_input ->> 'limit')::integer, 50), 1), 100);
begin
  perform private.require_active_user();
  select * into v_unit
  from app.units
  where id = (p_input ->> 'unitId')::uuid;
  if not found or not private.is_collection_member(v_unit.collection_id) then
    raise exception using errcode = 'P0001', message = 'UNIT_NOT_FOUND';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', revision.id,
    'unitId', revision.unit_id,
    'revision', revision.revision,
    'createdBy', revision.created_by,
    'action', revision.action,
    'createdAt', revision.created_at
  ) order by revision.revision desc), '[]')
  into v_items
  from (
    select *
    from app.unit_revisions
    where unit_id = v_unit.id
      and (
        p_input ->> 'cursor' is null
        or revision < (p_input ->> 'cursor')::bigint
      )
    order by revision desc
    limit v_limit
  ) as revision;

  return jsonb_build_object(
    'items', v_items,
    'nextCursor', case
      when jsonb_array_length(v_items) = v_limit
      then v_items -> (jsonb_array_length(v_items) - 1) ->> 'revision'
      else null
    end
  );
end;
$$;

create or replace function private.api_unit_revision_restore(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_unit app.units;
  v_source app.unit_revisions;
begin
  select * into v_unit
  from app.units
  where id = (p_input ->> 'unitId')::uuid
  for update;

  if not found or not private.has_collection_permission(v_unit.collection_id, 'edit_content') then
    raise exception using errcode = '42501', message = 'UNIT_FORBIDDEN';
  end if;
  if v_unit.revision is distinct from (p_input ->> 'expectedRevision')::bigint then
    raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
  end if;

  select * into v_source
  from app.unit_revisions
  where unit_id = v_unit.id
    and (
      id = nullif(p_input ->> 'revisionId', '')::uuid
      or revision = nullif(p_input ->> 'revision', '')::bigint
    )
  order by revision desc
  limit 1;

  if not found then
    raise exception using errcode = 'P0001', message = 'REVISION_NOT_FOUND';
  end if;

  update app.units
  set name = v_source.snapshot ->> 'name',
      description = v_source.snapshot ->> 'description',
      instruction_override = v_source.snapshot ->> 'instructionOverride',
      language_code = v_source.snapshot ->> 'languageCode',
      words = v_source.snapshot -> 'words',
      phrases = v_source.snapshot -> 'phrases',
      sentences = v_source.snapshot -> 'sentences',
      documents = v_source.snapshot -> 'documents',
      deleted_at = null,
      delete_after = null,
      revision = revision + 1
  where id = v_unit.id
  returning * into v_unit;

  insert into app.unit_revisions (
    unit_id, collection_id, revision, snapshot, created_by, action
  )
  values (
    v_unit.id,
    v_unit.collection_id,
    v_unit.revision,
    private.unit_snapshot(v_unit),
    v_user_id,
    'restored'
  );

  return private.unit_json(v_unit);
end;
$$;

create or replace function private.api_lesson_list(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_collection_id uuid := (p_input ->> 'collectionId')::uuid;
  v_limit integer := least(greatest(coalesce((p_input ->> 'limit')::integer, 50), 1), 100);
  v_items jsonb;
begin
  if v_collection_id is not null
     and not private.is_collection_member(v_collection_id) then
    raise exception using errcode = '42501', message = 'COLLECTION_FORBIDDEN';
  end if;

  select coalesce(jsonb_agg(private.lesson_summary_json(lesson)
    order by lesson.created_at desc, lesson.id desc), '[]')
  into v_items
  from (
    select listed_lesson.*
    from app.lessons as listed_lesson
    where (
        v_collection_id is null
        or listed_lesson.collection_id = v_collection_id
      )
      and exists (
        select 1
        from app.collection_members as member
        where member.collection_id = listed_lesson.collection_id
          and member.user_id = v_user_id
      )
      and listed_lesson.deleted_at is null
      and (
        p_input ->> 'unitId' is null
        or listed_lesson.unit_id = (p_input ->> 'unitId')::uuid
      )
      and (
        p_input ->> 'status' is null
        or listed_lesson.status = p_input ->> 'status'
      )
      and (
        p_input ->> 'cursor' is null
        or (listed_lesson.created_at, listed_lesson.id::text) < (
          split_part(
            convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'),
            '|',
            1
          )::timestamptz,
          split_part(
            convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'),
            '|',
            2
          )
        )
      )
      and (
        listed_lesson.status = 'published'
        or listed_lesson.created_by = v_user_id
        or private.has_collection_permission(
          listed_lesson.collection_id,
          'publish_lessons'
        )
      )
    order by listed_lesson.created_at desc, listed_lesson.id desc
    limit v_limit
  ) as lesson;

  return jsonb_build_object(
    'items', v_items,
    'nextCursor', case
      when jsonb_array_length(v_items) = v_limit
      then private.encode_cursor(
        (v_items -> (jsonb_array_length(v_items) - 1) ->> 'createdAt')::timestamptz,
        v_items -> (jsonb_array_length(v_items) - 1) ->> 'id'
      )
      else null
    end
  );
exception
  when invalid_parameter_value or invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CURSOR';
end;
$$;

create or replace function private.api_lesson_get(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_lesson app.lessons;
begin
  select * into v_lesson
  from app.lessons
  where id = (p_input ->> 'lessonId')::uuid;

  if not found
     or not private.is_collection_member(v_lesson.collection_id)
     or (
       v_lesson.status <> 'published'
       and v_lesson.created_by is distinct from v_user_id
       and not private.has_collection_permission(v_lesson.collection_id, 'publish_lessons')
     ) then
    raise exception using errcode = 'P0001', message = 'LESSON_NOT_FOUND';
  end if;

  return private.lesson_json(v_lesson);
end;
$$;

create or replace function private.api_lesson_create(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_unit app.units;
  v_source app.unit_revisions;
  v_lesson app.lessons;
  v_unit_revision bigint;
  v_idempotency_key text := nullif(p_input ->> 'idempotencyKey', '');
begin
  select * into v_unit
  from app.units
  where id = (p_input ->> 'unitId')::uuid
    and collection_id = (p_input ->> 'collectionId')::uuid
    and deleted_at is null;

  if not found or not private.has_collection_permission(v_unit.collection_id, 'create_lessons') then
    raise exception using errcode = '42501', message = 'LESSON_FORBIDDEN';
  end if;

  v_unit_revision := coalesce(
    nullif(p_input ->> 'unitRevision', '')::bigint,
    v_unit.revision
  );
  select * into v_source
  from app.unit_revisions
  where unit_id = v_unit.id and revision = v_unit_revision;

  if not found then
    raise exception using errcode = 'P0001', message = 'UNIT_REVISION_NOT_FOUND';
  end if;
  if p_input ->> 'languageCode'
       is distinct from v_source.snapshot ->> 'languageCode' then
    raise exception using errcode = '22023', message = 'LESSON_LANGUAGE_MISMATCH';
  end if;
  if not private.lesson_payload_is_valid(v_source.snapshot, p_input -> 'payload') then
    raise exception using errcode = '22023', message = 'INVALID_LESSON_TRACKING';
  end if;

  if v_idempotency_key is not null then
    select * into v_lesson
    from app.lessons
    where collection_id = v_unit.collection_id
      and created_by = v_user_id
      and idempotency_key = v_idempotency_key;
    if found then
      return private.lesson_json(v_lesson);
    end if;
  end if;

  insert into app.lessons (
    collection_id,
    unit_id,
    unit_revision,
    created_by,
    idempotency_key,
    title,
    language_code,
    schema_version,
    payload
  )
  values (
    v_unit.collection_id,
    v_unit.id,
    v_unit_revision,
    v_user_id,
    v_idempotency_key,
    private.normalize_surface(p_input ->> 'title'),
    v_source.snapshot ->> 'languageCode',
    8,
    p_input -> 'payload'
  )
  on conflict (collection_id, created_by, idempotency_key)
    where idempotency_key is not null
    do nothing
  returning * into v_lesson;

  if not found then
    select * into v_lesson
    from app.lessons
    where collection_id = v_unit.collection_id
      and created_by = v_user_id
      and idempotency_key = v_idempotency_key;
  end if;

  return private.lesson_json(v_lesson);
end;
$$;

create or replace function private.api_lesson_publish(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_lesson app.lessons;
begin
  select * into v_lesson
  from app.lessons
  where id = (p_input ->> 'lessonId')::uuid
  for update;
  if not found or not private.has_collection_permission(v_lesson.collection_id, 'publish_lessons') then
    raise exception using errcode = '42501', message = 'LESSON_FORBIDDEN';
  end if;
  if v_lesson.revision is distinct from (p_input ->> 'expectedRevision')::bigint then
    raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
  end if;

  update app.lessons
  set status = 'published',
      published_at = coalesce(published_at, statement_timestamp()),
      published_by = coalesce(published_by, v_user_id),
      revision = revision + 1
  where id = v_lesson.id
  returning * into v_lesson;
  return private.lesson_json(v_lesson);
end;
$$;

create or replace function private.api_lesson_unpublish(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lesson app.lessons;
begin
  perform private.require_active_user();
  select * into v_lesson
  from app.lessons
  where id = (p_input ->> 'lessonId')::uuid
  for update;
  if not found or not private.has_collection_permission(v_lesson.collection_id, 'publish_lessons') then
    raise exception using errcode = '42501', message = 'LESSON_FORBIDDEN';
  end if;
  if v_lesson.revision is distinct from (p_input ->> 'expectedRevision')::bigint then
    raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
  end if;

  update app.lessons
  set status = 'draft',
      published_at = null,
      published_by = null,
      revision = revision + 1
  where id = v_lesson.id
  returning * into v_lesson;
  return private.lesson_json(v_lesson);
end;
$$;

create or replace function private.api_lesson_delete(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_lesson app.lessons;
begin
  select * into v_lesson
  from app.lessons
  where id = (p_input ->> 'lessonId')::uuid
  for update;
  if not found
     or not (
       (v_lesson.status = 'draft' and v_lesson.created_by = v_user_id)
       or private.has_collection_permission(v_lesson.collection_id, 'delete_content')
     ) then
    raise exception using errcode = '42501', message = 'LESSON_FORBIDDEN';
  end if;
  if v_lesson.revision is distinct from (p_input ->> 'expectedRevision')::bigint then
    raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
  end if;

  update app.lessons
  set deleted_at = coalesce(deleted_at, statement_timestamp()),
      revision = revision + 1
  where id = v_lesson.id
  returning * into v_lesson;
  return private.lesson_json(v_lesson);
end;
$$;

create or replace function private.bump_term_stats(
  p_stats jsonb,
  p_term text,
  p_encounter_delta integer,
  p_correct_delta integer,
  p_incorrect_delta integer,
  p_at timestamptz
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_current jsonb := coalesce(p_stats -> p_term, '{}'::jsonb);
  v_first_seen jsonb := v_current -> 'firstSeenAt';
  v_learned_at jsonb := v_current -> 'learnedAt';
  v_new jsonb;
begin
  if v_first_seen is null or v_first_seen = 'null'::jsonb then
    v_first_seen := to_jsonb(p_at);
  end if;
  if p_correct_delta > 0
     and (v_learned_at is null or v_learned_at = 'null'::jsonb) then
    v_learned_at := to_jsonb(p_at);
  end if;

  v_new := jsonb_build_object(
    'encounterCount', coalesce((v_current ->> 'encounterCount')::bigint, 0)
      + p_encounter_delta,
    'correctCount', coalesce((v_current ->> 'correctCount')::bigint, 0)
      + p_correct_delta,
    'incorrectCount', coalesce((v_current ->> 'incorrectCount')::bigint, 0)
      + p_incorrect_delta,
    'firstSeenAt', v_first_seen,
    'lastSeenAt', p_at,
    'learnedAt', v_learned_at
  );

  return coalesce(p_stats, '{}'::jsonb) || jsonb_build_object(p_term, v_new);
end;
$$;

create or replace function private.bump_aggregate(
  p_aggregate jsonb,
  p_key text,
  p_delta bigint
)
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(p_aggregate, '{}'::jsonb)
    || jsonb_build_object(
      p_key,
      coalesce((p_aggregate ->> p_key)::bigint, 0) + p_delta
    );
$$;

create or replace function private.api_progress_start(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_idempotency_key text := nullif(p_input ->> 'idempotencyKey', '');
  v_lesson_id uuid := (p_input ->> 'lessonId')::uuid;
  v_lesson app.lessons;
  v_progress app.lesson_progress;
begin
  if v_idempotency_key is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'progress-start:' || v_user_id::text || ':' || v_idempotency_key,
      0
    )
  );

  select * into v_progress
  from app.lesson_progress
  where user_id = v_user_id
    and start_idempotency_key = v_idempotency_key;
  if found then
    if v_progress.lesson_id is distinct from v_lesson_id then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_build_object(
      'id', v_progress.id,
      'lessonId', v_progress.lesson_id,
      'collectionId', v_progress.collection_id,
      'userId', v_progress.user_id,
      'languageCode', v_progress.language_code,
      'status', v_progress.status,
      'summary', v_progress.summary,
      'revision', v_progress.revision,
      'startedAt', v_progress.started_at
    );
  end if;

  select * into v_lesson
  from app.lessons
  where id = v_lesson_id
    and deleted_at is null;

  if not found
     or not private.is_collection_member(v_lesson.collection_id)
     or (
       v_lesson.status <> 'published'
       and v_lesson.created_by is distinct from v_user_id
       and not private.has_collection_permission(
         v_lesson.collection_id,
         'publish_lessons'
       )
     ) then
    raise exception using errcode = 'P0001', message = 'LESSON_NOT_AVAILABLE';
  end if;

  insert into app.lesson_progress (
    lesson_id,
    collection_id,
    user_id,
    start_idempotency_key,
    language_code
  )
  values (
    v_lesson.id,
    v_lesson.collection_id,
    v_user_id,
    v_idempotency_key,
    v_lesson.language_code
  )
  returning * into v_progress;

  insert into app.user_language_stats (
    user_id,
    language_code,
    aggregate
  )
  values (
    v_user_id,
    v_lesson.language_code,
    jsonb_build_object('sessionCount', 1)
  )
  on conflict (user_id, language_code) do update
    set aggregate = private.bump_aggregate(
          app.user_language_stats.aggregate,
          'sessionCount',
          1
        ),
        revision = app.user_language_stats.revision + 1;

  insert into app.collection_user_language_stats (
    collection_id,
    user_id,
    language_code,
    aggregate
  )
  values (
    v_lesson.collection_id,
    v_user_id,
    v_lesson.language_code,
    jsonb_build_object('sessionCount', 1)
  )
  on conflict (collection_id, user_id, language_code) do update
    set aggregate = private.bump_aggregate(
          app.collection_user_language_stats.aggregate,
          'sessionCount',
          1
        ),
        revision = app.collection_user_language_stats.revision + 1;

  return jsonb_build_object(
    'id', v_progress.id,
    'lessonId', v_progress.lesson_id,
    'collectionId', v_progress.collection_id,
    'userId', v_progress.user_id,
    'languageCode', v_progress.language_code,
    'status', v_progress.status,
    'summary', v_progress.summary,
    'revision', v_progress.revision,
    'startedAt', v_progress.started_at
  );
end;
$$;

create or replace function private.api_progress_submit_batch(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_batch_id uuid := (p_input ->> 'batchId')::uuid;
  v_progress_id uuid := (p_input ->> 'progressId')::uuid;
  v_payload_hash bytea := extensions.digest(
    convert_to(p_input::text, 'UTF8'),
    'sha256'
  );
  v_existing app.progress_batches;
  v_progress app.lesson_progress;
  v_lesson app.lessons;
  v_global app.user_language_stats;
  v_collection app.collection_user_language_stats;
  v_event jsonb;
  v_question jsonb;
  v_sanitized jsonb;
  v_attempts jsonb;
  v_summary jsonb;
  v_encountered_ids jsonb;
  v_question_id text;
  v_event_id uuid;
  v_attempt_id uuid;
  v_status text;
  v_evaluation_source text;
  v_answered_at timestamptz;
  v_client_answered_at timestamptz;
  v_is_first_question boolean;
  v_category text;
  v_term text;
  v_global_category_stats jsonb;
  v_collection_category_stats jsonb;
  v_correct_delta integer;
  v_incorrect_delta integer;
  v_result jsonb;
  v_new_attempts integer := 0;
  v_correct_attempts integer := 0;
  v_incorrect_attempts integer := 0;
  v_encountered_targets integer := 0;
begin
  if jsonb_typeof(p_input -> 'events') is distinct from 'array'
     or jsonb_array_length(p_input -> 'events') = 0
     or jsonb_array_length(p_input -> 'events') > 100 then
    raise exception using errcode = '22023', message = 'INVALID_PROGRESS_BATCH';
  end if;
  if (
    select count(*)
    from jsonb_array_elements(p_input -> 'events')
  ) <> (
    select count(distinct value ->> 'eventId')
    from jsonb_array_elements(p_input -> 'events')
  ) or (
    select count(*)
    from jsonb_array_elements(p_input -> 'events')
  ) <> (
    select count(distinct value ->> 'attemptId')
    from jsonb_array_elements(p_input -> 'events')
  ) then
    raise exception using errcode = '22023', message = 'DUPLICATE_PROGRESS_EVENT';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_batch_id::text, 0));

  select * into v_existing
  from app.progress_batches
  where batch_id = v_batch_id;
  if found then
    if v_existing.user_id <> v_user_id
       or v_existing.payload_hash <> v_payload_hash then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return v_existing.result;
  end if;

  select * into v_progress
  from app.lesson_progress
  where id = v_progress_id
    and user_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PROGRESS_NOT_FOUND';
  end if;
  if v_progress.status <> 'in_progress' then
    raise exception using errcode = '23514', message = 'PROGRESS_ALREADY_CLOSED';
  end if;

  select * into v_lesson
  from app.lessons
  where id = v_progress.lesson_id;

  insert into app.user_language_stats (user_id, language_code)
  values (v_user_id, v_progress.language_code)
  on conflict do nothing;
  select * into v_global
  from app.user_language_stats
  where user_id = v_user_id
    and language_code = v_progress.language_code
  for update;

  insert into app.collection_user_language_stats (
    collection_id,
    user_id,
    language_code
  )
  values (
    v_progress.collection_id,
    v_user_id,
    v_progress.language_code
  )
  on conflict do nothing;
  select * into v_collection
  from app.collection_user_language_stats
  where collection_id = v_progress.collection_id
    and user_id = v_user_id
    and language_code = v_progress.language_code
  for update;

  v_attempts := v_progress.attempts;
  v_summary := v_progress.summary;
  v_encountered_ids := coalesce(v_summary -> 'encounteredQuestionIds', '[]'::jsonb);

  for v_event in
    select value
    from jsonb_array_elements(p_input -> 'events')
  loop
    v_event_id := (v_event ->> 'eventId')::uuid;
    v_attempt_id := (v_event ->> 'attemptId')::uuid;
    v_question_id := v_event ->> 'questionId';
    v_status := coalesce(v_event ->> 'status', v_event ->> 'outcome');
    v_evaluation_source := coalesce(v_event ->> 'evaluationSource', 'deterministic');
    v_answered_at := statement_timestamp();
    v_client_answered_at := nullif(v_event ->> 'answeredAt', '')::timestamptz;

    if v_question_id is null
       or coalesce((v_event ->> 'attemptNumber')::integer, 0) < 1
       or coalesce(v_status, '') not in ('correct', 'incorrect', 'skipped')
       or coalesce(v_evaluation_source, '')
            not in ('deterministic', 'client_extension')
       or octet_length(coalesce((v_event -> 'answer')::text, '')) > 10000
       or octet_length(coalesce(v_event ->> 'transcript', '')) > 20000
       or (
         v_event ? 'score'
         and (
           (v_event ->> 'score')::numeric < 0
           or (v_event ->> 'score')::numeric > 1
         )
       ) then
      raise exception using errcode = '22023', message = 'INVALID_PROGRESS_EVENT';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(v_attempts) as attempt(value)
      where attempt.value ->> 'eventId' = v_event_id::text
         or attempt.value ->> 'attemptId' = v_attempt_id::text
    ) then
      continue;
    end if;

    select value into v_question
    from jsonb_array_elements(v_lesson.payload -> 'questions') as question(value)
    where coalesce(
      question.value ->> 'questionId',
      question.value ->> 'id'
    ) = v_question_id
    limit 1;

    if not found then
      raise exception using errcode = '22023', message = 'QUESTION_NOT_FOUND';
    end if;

    v_sanitized := jsonb_strip_nulls(jsonb_build_object(
      'eventId', v_event_id,
      'questionId', v_question_id,
      'attemptId', v_attempt_id,
      'attemptNumber', (v_event ->> 'attemptNumber')::integer,
      'answer', v_event -> 'answer',
      'transcript', nullif(v_event ->> 'transcript', ''),
      'status', v_status,
      'score', case
        when v_event ? 'score' then (v_event ->> 'score')::numeric
        else null
      end,
      'answeredAt', v_answered_at,
      'clientAnsweredAt', v_client_answered_at,
      'evaluationSource', v_evaluation_source
    ));

    v_attempts := v_attempts || jsonb_build_array(v_sanitized);
    v_new_attempts := v_new_attempts + 1;
    v_correct_delta := case when v_status = 'correct' then 1 else 0 end;
    v_incorrect_delta := case when v_status = 'incorrect' then 1 else 0 end;
    v_correct_attempts := v_correct_attempts + v_correct_delta;
    v_incorrect_attempts := v_incorrect_attempts + v_incorrect_delta;

    v_is_first_question := not exists (
      select 1
      from jsonb_array_elements_text(v_encountered_ids) as encountered(value)
      where encountered.value = v_question_id
    );
    if v_is_first_question then
      v_encountered_ids := v_encountered_ids || to_jsonb(v_question_id);
    end if;

    foreach v_category in array array['words', 'phrases', 'sentences']
    loop
      v_global_category_stats := case v_category
        when 'words' then v_global.words
        when 'phrases' then v_global.phrases
        else v_global.sentences
      end;
      v_collection_category_stats := case v_category
        when 'words' then v_collection.words
        when 'phrases' then v_collection.phrases
        else v_collection.sentences
      end;

      if v_is_first_question then
        for v_term in
          select value
          from jsonb_array_elements_text(coalesce(
            v_question #> array['tracking', 'encountered', v_category],
            '[]'::jsonb
          ))
        loop
          v_global_category_stats := private.bump_term_stats(
            v_global_category_stats,
            v_term,
            1,
            0,
            0,
            v_answered_at
          );
          v_collection_category_stats := private.bump_term_stats(
            v_collection_category_stats,
            v_term,
            1,
            0,
            0,
            v_answered_at
          );
          v_encountered_targets := v_encountered_targets + 1;
        end loop;
      end if;

      if v_correct_delta + v_incorrect_delta > 0 then
        for v_term in
          select value
          from jsonb_array_elements_text(coalesce(
            v_question #> array['tracking', 'assessed', v_category],
            '[]'::jsonb
          ))
        loop
          v_global_category_stats := private.bump_term_stats(
            v_global_category_stats,
            v_term,
            0,
            v_correct_delta,
            v_incorrect_delta,
            v_answered_at
          );
          v_collection_category_stats := private.bump_term_stats(
            v_collection_category_stats,
            v_term,
            0,
            v_correct_delta,
            v_incorrect_delta,
            v_answered_at
          );
        end loop;
      end if;

      if v_category = 'words' then
        v_global.words := v_global_category_stats;
        v_collection.words := v_collection_category_stats;
      elsif v_category = 'phrases' then
        v_global.phrases := v_global_category_stats;
        v_collection.phrases := v_collection_category_stats;
      else
        v_global.sentences := v_global_category_stats;
        v_collection.sentences := v_collection_category_stats;
      end if;
    end loop;
  end loop;

  if jsonb_array_length(v_attempts) > 5000
     or octet_length(v_attempts::text) > 8388608 then
    raise exception using errcode = '54000', message = 'PROGRESS_TOO_LARGE';
  end if;

  v_summary := v_summary
    || jsonb_build_object(
      'encounteredQuestionIds', v_encountered_ids,
      'attemptCount', coalesce((v_summary ->> 'attemptCount')::bigint, 0)
        + v_new_attempts,
      'correctCount', coalesce((v_summary ->> 'correctCount')::bigint, 0)
        + v_correct_attempts,
      'incorrectCount', coalesce((v_summary ->> 'incorrectCount')::bigint, 0)
        + v_incorrect_attempts,
      'lastAnsweredAt', statement_timestamp()
    );

  v_global.aggregate := private.bump_aggregate(
    private.bump_aggregate(
      private.bump_aggregate(
        private.bump_aggregate(v_global.aggregate, 'attemptCount', v_new_attempts),
        'correctCount',
        v_correct_attempts
      ),
      'incorrectCount',
      v_incorrect_attempts
    ),
    'encounterCount',
    v_encountered_targets
  );
  update app.user_language_stats
  set words = v_global.words,
      phrases = v_global.phrases,
      sentences = v_global.sentences,
      aggregate = v_global.aggregate,
      revision = revision + 1
  where user_id = v_user_id
    and language_code = v_progress.language_code;

  update app.collection_user_language_stats
  set words = v_collection.words,
      phrases = v_collection.phrases,
      sentences = v_collection.sentences,
      aggregate = private.bump_aggregate(
        private.bump_aggregate(
          private.bump_aggregate(
            private.bump_aggregate(
              aggregate,
              'attemptCount',
              v_new_attempts
            ),
            'correctCount',
            v_correct_attempts
          ),
          'incorrectCount',
          v_incorrect_attempts
        ),
        'encounterCount',
        v_encountered_targets
      ),
      revision = revision + 1
  where collection_id = v_progress.collection_id
    and user_id = v_user_id
    and language_code = v_progress.language_code;

  update app.lesson_progress
  set attempts = v_attempts,
      summary = v_summary,
      status = case
        when nullif(p_input ->> 'completedAt', '') is not null
          or coalesce((p_input ->> 'complete')::boolean, false)
        then 'completed'
        else status
      end,
      completed_at = case
        when nullif(p_input ->> 'completedAt', '') is not null
          then statement_timestamp()
        when coalesce((p_input ->> 'complete')::boolean, false)
          then statement_timestamp()
        else completed_at
      end,
      revision = revision + 1
  where id = v_progress.id
  returning * into v_progress;

  v_result := jsonb_build_object(
    'progressId', v_progress.id,
    'batchId', v_batch_id,
    'status', v_progress.status,
    'summary', v_progress.summary,
    'revision', v_progress.revision,
    'completedAt', v_progress.completed_at,
    'acceptedEvents', v_new_attempts
  );

  insert into app.progress_batches (
    batch_id,
    progress_id,
    user_id,
    payload_hash,
    result
  )
  values (
    v_batch_id,
    v_progress.id,
    v_user_id,
    v_payload_hash,
    v_result
  );

  return v_result;
end;
$$;

create or replace function private.api_progress_history(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_active_user();
  v_target_id uuid := coalesce(nullif(p_input ->> 'userId', '')::uuid, v_actor_id);
  v_collection_id uuid := nullif(p_input ->> 'collectionId', '')::uuid;
  v_limit integer := least(greatest(coalesce((p_input ->> 'limit')::integer, 50), 1), 100);
  v_items jsonb;
begin
  if v_target_id <> v_actor_id then
    if v_collection_id is null
       or not private.has_collection_permission(v_collection_id, 'view_member_progress') then
      raise exception using errcode = '42501', message = 'PROGRESS_FORBIDDEN';
    end if;
  end if;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', progress.id,
    'lessonId', progress.lesson_id,
    'collectionId', progress.collection_id,
    'userId', progress.user_id,
    'languageCode', progress.language_code,
    'status', progress.status,
    'summary', progress.summary,
    'revision', progress.revision,
    'startedAt', progress.started_at,
    'completedAt', progress.completed_at,
    'updatedAt', progress.updated_at
  )) order by progress.started_at desc, progress.id desc), '[]')
  into v_items
  from (
    select *
    from app.lesson_progress
    where user_id = v_target_id
      and (v_collection_id is null or collection_id = v_collection_id)
      and (
        p_input ->> 'lessonId' is null
        or lesson_id = (p_input ->> 'lessonId')::uuid
      )
      and (
        p_input ->> 'cursor' is null
        or (started_at, id::text) < (
          split_part(
            convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'),
            '|',
            1
          )::timestamptz,
          split_part(
            convert_from(decode(p_input ->> 'cursor', 'base64'), 'UTF8'),
            '|',
            2
          )
        )
      )
    order by started_at desc, id desc
    limit v_limit
  ) as progress;

  return jsonb_build_object(
    'items', v_items,
    'nextCursor', case
      when jsonb_array_length(v_items) = v_limit
      then private.encode_cursor(
        (v_items -> (jsonb_array_length(v_items) - 1) ->> 'startedAt')::timestamptz,
        v_items -> (jsonb_array_length(v_items) - 1) ->> 'id'
      )
      else null
    end
  );
exception
  when invalid_parameter_value or invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CURSOR';
end;
$$;

create or replace function private.api_progress_get(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_active_user();
  v_progress app.lesson_progress;
begin
  select * into v_progress
  from app.lesson_progress
  where id = (p_input ->> 'progressId')::uuid;

  if not found then
    raise exception using errcode = 'P0001', message = 'PROGRESS_NOT_FOUND';
  end if;

  if v_progress.user_id <> v_actor_id
     and not private.has_collection_permission(
       v_progress.collection_id,
       'view_member_progress'
     ) then
    raise exception using errcode = '42501', message = 'PROGRESS_FORBIDDEN';
  end if;

  if v_progress.user_id <> v_actor_id
     and not private.has_collection_permission(
       v_progress.collection_id,
       'view_member_answers'
     ) then
    raise exception using errcode = '42501', message = 'PROGRESS_ANSWERS_FORBIDDEN';
  end if;

  return jsonb_build_object(
    'id', v_progress.id,
    'lessonId', v_progress.lesson_id,
    'collectionId', v_progress.collection_id,
    'userId', v_progress.user_id,
    'languageCode', v_progress.language_code,
    'status', v_progress.status,
    'summary', v_progress.summary,
    'attempts', v_progress.attempts,
    'revision', v_progress.revision,
    'startedAt', v_progress.started_at,
    'completedAt', v_progress.completed_at,
    'updatedAt', v_progress.updated_at
  );
end;
$$;

create or replace function private.api_stats_get(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_stats app.user_language_stats;
begin
  select * into v_stats
  from app.user_language_stats
  where user_id = v_user_id
    and language_code = p_input ->> 'languageCode';

  return jsonb_build_object(
    'userId', v_user_id,
    'languageCode', p_input ->> 'languageCode',
    'words', coalesce(v_stats.words, '{}'),
    'phrases', coalesce(v_stats.phrases, '{}'),
    'sentences', coalesce(v_stats.sentences, '{}'),
    'aggregate', coalesce(v_stats.aggregate, '{}'),
    'revision', coalesce(v_stats.revision, 0),
    'updatedAt', v_stats.updated_at
  );
end;
$$;

create or replace function private.api_stats_collection_get(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_active_user();
  v_collection_id uuid := (p_input ->> 'collectionId')::uuid;
  v_target_id uuid := coalesce(nullif(p_input ->> 'userId', '')::uuid, v_actor_id);
  v_stats app.collection_user_language_stats;
begin
  if v_target_id <> v_actor_id
     and not private.has_collection_permission(v_collection_id, 'view_member_progress') then
    raise exception using errcode = '42501', message = 'STATS_FORBIDDEN';
  end if;
  if not private.is_collection_member(v_collection_id) then
    raise exception using errcode = '42501', message = 'COLLECTION_FORBIDDEN';
  end if;

  select * into v_stats
  from app.collection_user_language_stats
  where collection_id = v_collection_id
    and user_id = v_target_id
    and language_code = p_input ->> 'languageCode';

  return jsonb_build_object(
    'collectionId', v_collection_id,
    'userId', v_target_id,
    'languageCode', p_input ->> 'languageCode',
    'words', coalesce(v_stats.words, '{}'),
    'phrases', coalesce(v_stats.phrases, '{}'),
    'sentences', coalesce(v_stats.sentences, '{}'),
    'aggregate', coalesce(v_stats.aggregate, '{}'),
    'revision', coalesce(v_stats.revision, 0),
    'updatedAt', v_stats.updated_at
  );
end;
$$;

create or replace function private.api_character_progress_get(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_progress app.user_character_progress;
begin
  select * into v_progress
  from app.user_character_progress
  where user_id = v_user_id
    and language_code = p_input ->> 'languageCode';

  return jsonb_build_object(
    'userId', v_user_id,
    'languageCode', p_input ->> 'languageCode',
    'characters', coalesce(v_progress.characters, '{}'),
    'revision', coalesce(v_progress.revision, 0),
    'updatedAt', v_progress.updated_at
  );
end;
$$;

create or replace function private.api_character_progress_upsert(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_progress app.user_character_progress;
  v_expected bigint := coalesce((p_input ->> 'expectedRevision')::bigint, 0);
begin
  if jsonb_typeof(p_input -> 'characters') <> 'object' then
    raise exception using errcode = '22023', message = 'INVALID_CHARACTER_PROGRESS';
  end if;

  select * into v_progress
  from app.user_character_progress
  where user_id = v_user_id
    and language_code = p_input ->> 'languageCode'
  for update;

  if found then
    if v_progress.revision <> v_expected then
      raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
    end if;
    update app.user_character_progress
    set characters = p_input -> 'characters',
        revision = revision + 1
    where user_id = v_user_id
      and language_code = v_progress.language_code
    returning * into v_progress;
  else
    if v_expected <> 0 then
      raise exception using errcode = '40001', message = 'REVISION_CONFLICT';
    end if;
    insert into app.user_character_progress (
      user_id,
      language_code,
      characters
    )
    values (
      v_user_id,
      p_input ->> 'languageCode',
      p_input -> 'characters'
    )
    returning * into v_progress;
  end if;

  return jsonb_build_object(
    'userId', v_progress.user_id,
    'languageCode', v_progress.language_code,
    'characters', v_progress.characters,
    'revision', v_progress.revision,
    'updatedAt', v_progress.updated_at
  );
end;
$$;

create or replace function private.api_file_create_pending(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_asset_id uuid := (p_input ->> 'assetId')::uuid;
  v_collection_id uuid := nullif(p_input ->> 'collectionId', '')::uuid;
  v_size_bytes bigint := (p_input ->> 'sizeBytes')::bigint;
  v_expected_key text;
  v_asset app.file_assets;
  v_idempotency_key text := nullif(p_input ->> 'idempotencyKey', '');
begin
  if v_collection_id is not null
     and not (
       private.has_collection_permission(v_collection_id, 'create_content')
       or private.has_collection_permission(v_collection_id, 'edit_content')
     ) then
    raise exception using errcode = '42501', message = 'FILE_UPLOAD_FORBIDDEN';
  end if;

  if v_idempotency_key is not null then
    select * into v_asset
    from app.file_assets
    where owner_id = v_user_id
      and idempotency_key = v_idempotency_key;
    if found then
      return jsonb_build_object(
        'id', v_asset.id,
        'collectionId', v_asset.collection_id,
        'key', v_asset.r2_key,
        'fileName', v_asset.original_filename,
        'contentType', v_asset.mime_type,
        'sizeBytes', v_asset.expected_size_bytes,
        'sha256', encode(v_asset.expected_sha256, 'hex'),
        'status', v_asset.status,
        'pendingExpiresAt', v_asset.pending_expires_at,
        'createdAt', v_asset.created_at
      );
    end if;
  end if;

  -- The binding-side limiter is approximate; serialize the durable DB quota.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('file-upload:' || v_user_id::text, 0)
  );

  if (
    select count(*)
    from app.file_assets
    where owner_id = v_user_id
      and created_at >= statement_timestamp() - interval '1 hour'
  ) >= 30 then
    raise exception using errcode = '54000', message = 'UPLOAD_HOURLY_LIMIT';
  end if;

  if (
    select coalesce(sum(expected_size_bytes), 0)
    from app.file_assets
    where owner_id = v_user_id
      and created_at >= statement_timestamp() - interval '1 day'
  ) + v_size_bytes > 262144000 then
    raise exception using errcode = '54000', message = 'UPLOAD_DAILY_QUOTA';
  end if;

  v_expected_key := case
    when v_collection_id is null
      then 'users/' || v_user_id::text || '/' || v_asset_id::text
    else 'collections/' || v_collection_id::text || '/' || v_user_id::text
      || '/' || v_asset_id::text
  end;
  if p_input ->> 'key' <> v_expected_key then
    raise exception using errcode = '22023', message = 'INVALID_R2_KEY';
  end if;

  insert into app.file_assets (
    id,
    collection_id,
    owner_id,
    idempotency_key,
    r2_key,
    original_filename,
    mime_type,
    expected_size_bytes,
    expected_sha256
  )
  values (
    v_asset_id,
    v_collection_id,
    v_user_id,
    v_idempotency_key,
    v_expected_key,
    p_input ->> 'fileName',
    p_input ->> 'contentType',
    v_size_bytes,
    decode(p_input ->> 'sha256', 'hex')
  )
  on conflict (owner_id, idempotency_key)
    where idempotency_key is not null
    do nothing
  returning * into v_asset;

  if not found then
    select * into v_asset
    from app.file_assets
    where owner_id = v_user_id
      and idempotency_key = v_idempotency_key;
  end if;

  return jsonb_build_object(
    'id', v_asset.id,
    'collectionId', v_asset.collection_id,
    'key', v_asset.r2_key,
    'fileName', v_asset.original_filename,
    'contentType', v_asset.mime_type,
    'sizeBytes', v_asset.expected_size_bytes,
    'sha256', encode(v_asset.expected_sha256, 'hex'),
    'status', v_asset.status,
    'pendingExpiresAt', v_asset.pending_expires_at,
    'createdAt', v_asset.created_at
  );
end;
$$;

create or replace function private.api_file_get(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_purpose text := p_input ->> 'purpose';
  v_asset app.file_assets;
begin
  select * into v_asset
  from app.file_assets
  where id = (p_input ->> 'assetId')::uuid;

  if not found or v_asset.status = 'deleted' then
    raise exception using errcode = 'P0001', message = 'FILE_NOT_FOUND';
  end if;

  if v_purpose = 'finalize' then
    if v_asset.owner_id is distinct from v_user_id
       or v_asset.status not in ('pending', 'ready') then
      raise exception using errcode = '42501', message = 'FILE_FORBIDDEN';
    end if;
  elsif v_purpose = 'download' then
    if v_asset.status <> 'ready'
       or not (
         v_asset.owner_id = v_user_id
         or (
           v_asset.collection_id is not null
           and private.is_collection_member(v_asset.collection_id)
         )
         or (
           v_asset.collection_id is null
           and (
             exists (
               select 1
               from app.profiles as profile
               where profile.avatar_asset_id = v_asset.id
                 and private.shares_collection_with(profile.user_id)
             )
             or exists (
               select 1
               from app.collection_profiles as profile
               where profile.avatar_asset_id = v_asset.id
                 and private.is_collection_member(profile.collection_id)
             )
           )
         )
       ) then
      raise exception using errcode = '42501', message = 'FILE_FORBIDDEN';
    end if;
  else
    raise exception using errcode = '22023', message = 'INVALID_FILE_PURPOSE';
  end if;

  return jsonb_build_object(
    'id', v_asset.id,
    'collectionId', v_asset.collection_id,
    'ownerId', v_asset.owner_id,
    'key', v_asset.r2_key,
    'fileName', v_asset.original_filename,
    'contentType', v_asset.mime_type,
    'sizeBytes', coalesce(v_asset.size_bytes, v_asset.expected_size_bytes),
    'sha256', encode(coalesce(v_asset.sha256, v_asset.expected_sha256), 'hex'),
    'etag', v_asset.etag,
    'status', v_asset.status,
    'uploadedAt', v_asset.uploaded_at,
    'createdAt', v_asset.created_at
  );
end;
$$;

create or replace function private.api_file_finalize(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_asset app.file_assets;
begin
  select * into v_asset
  from app.file_assets
  where id = (p_input ->> 'assetId')::uuid
  for update;

  if not found or v_asset.owner_id is distinct from v_user_id then
    raise exception using errcode = '42501', message = 'FILE_FORBIDDEN';
  end if;
  if v_asset.status = 'ready' then
    return private.api_file_get(jsonb_build_object(
      'assetId', v_asset.id,
      'purpose', 'download'
    ));
  end if;
  if v_asset.status <> 'pending'
     or v_asset.pending_expires_at <= statement_timestamp() then
    raise exception using errcode = '23514', message = 'UPLOAD_EXPIRED';
  end if;

  update app.file_assets
  set size_bytes = expected_size_bytes,
      sha256 = expected_sha256,
      etag = p_input ->> 'etag',
      uploaded_at = coalesce(
        nullif(p_input ->> 'uploadedAt', '')::timestamptz,
        statement_timestamp()
      ),
      ready_at = statement_timestamp(),
      status = 'ready'
  where id = v_asset.id
  returning * into v_asset;

  return jsonb_build_object(
    'id', v_asset.id,
    'collectionId', v_asset.collection_id,
    'key', v_asset.r2_key,
    'fileName', v_asset.original_filename,
    'contentType', v_asset.mime_type,
    'sizeBytes', v_asset.size_bytes,
    'sha256', encode(v_asset.sha256, 'hex'),
    'etag', v_asset.etag,
    'status', v_asset.status,
    'uploadedAt', v_asset.uploaded_at,
    'readyAt', v_asset.ready_at
  );
end;
$$;

create or replace function private.api_file_delete(
  p_input jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_asset app.file_assets;
begin
  select * into v_asset
  from app.file_assets
  where id = (p_input ->> 'assetId')::uuid
  for update;

  if not found
     or not (
       v_asset.owner_id = v_user_id
       or (
         v_asset.collection_id is not null
         and private.has_collection_permission(
           v_asset.collection_id,
           'edit_content'
         )
       )
     ) then
    raise exception using errcode = '42501', message = 'FILE_FORBIDDEN';
  end if;

  if v_asset.reference_count > 0
     or exists (
       select 1 from app.profiles where avatar_asset_id = v_asset.id
     )
     or exists (
       select 1 from app.collection_profiles where avatar_asset_id = v_asset.id
     )
     or exists (
       select 1
       from app.units as unit
       cross join lateral private.asset_reference_ids(unit.documents) as reference
       where reference.asset_id = v_asset.id
     )
     or exists (
       select 1
       from app.unit_revisions as revision
       cross join lateral private.asset_reference_ids(
         coalesce(revision.snapshot -> 'documents', '[]'::jsonb)
       ) as reference
       where reference.asset_id = v_asset.id
     )
     or exists (
       select 1
       from app.lessons as lesson
       cross join lateral private.asset_reference_ids(lesson.payload) as reference
       where reference.asset_id = v_asset.id
     ) then
    raise exception using errcode = '23503', message = 'FILE_IS_REFERENCED';
  end if;

  update app.file_assets
  set status = 'deleted',
      deleted_at = statement_timestamp()
  where id = v_asset.id
  returning * into v_asset;

  return jsonb_build_object(
    'id', v_asset.id,
    'key', v_asset.r2_key,
    'deleted', true
  );
end;
$$;

revoke execute on all functions in schema private from public, anon, authenticated;

do $$
declare
  v_function regprocedure;
begin
  for v_function in
    select procedure.oid::regprocedure
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname like 'api\_%' escape '\'
  loop
    execute format('grant execute on function %s to meoing_runtime', v_function);
  end loop;
end
$$;

revoke execute on function private.api_abuse_consume(jsonb)
  from public, anon, authenticated;
grant execute on function private.api_abuse_consume(jsonb)
  to meoing_runtime;

commit;

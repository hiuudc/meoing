begin;

create or replace function private.current_user_id()
returns uuid
language sql
stable
parallel safe
set search_path = ''
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid;
$$;

create or replace function private.require_user()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user_id uuid := private.current_user_id();
begin
  if v_user_id is null then
    raise exception using
      errcode = '28000',
      message = 'AUTH_REQUIRED';
  end if;
  return v_user_id;
end;
$$;

create or replace function private.require_active_user()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
begin
  if not exists (
    select 1
    from auth.users as auth_user
    join app.profiles as profile on profile.user_id = auth_user.id
    where auth_user.id = v_user_id
      and auth_user.email_confirmed_at is not null
      and profile.username is not null
      and profile.api_locked_at is null
  ) then
    raise exception using
      errcode = '42501',
      message = 'ACCOUNT_NOT_READY';
  end if;
  return v_user_id;
end;
$$;

create or replace function private.is_collection_member(p_collection_id uuid)
returns boolean
language sql
stable
security definer
parallel safe
set search_path = ''
as $$
  select private.current_user_id() is not null
    and exists (
      select 1
      from app.collection_members as member
      where member.collection_id = p_collection_id
        and member.user_id = private.current_user_id()
    );
$$;

create or replace function private.is_collection_owner(p_collection_id uuid)
returns boolean
language sql
stable
security definer
parallel safe
set search_path = ''
as $$
  select private.current_user_id() is not null
    and exists (
      select 1
      from app.collections as collection
      where collection.id = p_collection_id
        and collection.owner_id = private.current_user_id()
        and collection.deleted_at is null
    );
$$;

create or replace function private.has_collection_permission(
  p_collection_id uuid,
  p_permission text
)
returns boolean
language sql
stable
security definer
parallel safe
set search_path = ''
as $$
  select
    private.is_collection_owner(p_collection_id)
    or exists (
      select 1
      from app.collection_members as member
      join app.collections as collection
        on collection.id = member.collection_id
       and collection.deleted_at is null
      join app.collection_roles as role
        on role.collection_id = member.collection_id
      left join app.collection_member_roles as assignment
        on assignment.collection_id = member.collection_id
       and assignment.user_id = member.user_id
       and assignment.role_id = role.id
      where member.collection_id = p_collection_id
        and member.user_id = private.current_user_id()
        and (role.is_managed or assignment.role_id is not null)
        and p_permission = any(role.permissions)
    );
$$;

create or replace function private.max_security_rank(p_collection_id uuid)
returns integer
language sql
stable
security definer
parallel safe
set search_path = ''
as $$
  select case
    when private.is_collection_owner(p_collection_id) then 2147483647
    else coalesce((
      select max(role.security_rank)
      from app.collection_member_roles as assignment
      join app.collection_roles as role
        on role.collection_id = assignment.collection_id
       and role.id = assignment.role_id
      where assignment.collection_id = p_collection_id
        and assignment.user_id = private.current_user_id()
    ), 0)
  end;
$$;

create or replace function private.shares_collection_with(p_other_user_id uuid)
returns boolean
language sql
stable
security definer
parallel safe
set search_path = ''
as $$
  select private.current_user_id() is not null
    and (
      private.current_user_id() = p_other_user_id
      or exists (
        select 1
        from app.collection_members as mine
        join app.collection_members as theirs
          on theirs.collection_id = mine.collection_id
        join app.collections as collection
          on collection.id = mine.collection_id
         and collection.deleted_at is null
        where mine.user_id = private.current_user_id()
          and theirs.user_id = p_other_user_id
      )
    );
$$;

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := statement_timestamp();
  return new;
end;
$$;

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into app.profiles (user_id, display_name)
  values (
    new.id,
    coalesce(
      nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 64), ''),
      'Meoing User'
    )
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

create or replace function private.asset_reference_values(p_value jsonb)
returns table(reference_key text, raw_value jsonb)
language sql
immutable
parallel safe
set search_path = ''
as $$
  with recursive walk(reference_key, raw_value) as (
    select null::text, p_value
    union all
    select child.reference_key, child.raw_value
    from walk as parent
    cross join lateral (
      select entry.key, entry.value
      from jsonb_each(
        case
          when jsonb_typeof(parent.raw_value) = 'object'
            then parent.raw_value
          else '{}'::jsonb
        end
      ) as entry(key, value)
      union all
      select null::text, element.value
      from jsonb_array_elements(
        case
          when jsonb_typeof(parent.raw_value) = 'array'
            then parent.raw_value
          else '[]'::jsonb
        end
      ) as element(value)
    ) as child(reference_key, raw_value)
  )
  select walk.reference_key, walk.raw_value
  from walk
  where walk.reference_key in ('assetId', 'sourceAssetId');
$$;

create or replace function private.asset_reference_ids(p_value jsonb)
returns table(asset_id uuid)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select distinct (reference.raw_value #>> '{}')::uuid
  from private.asset_reference_values(p_value) as reference
  where jsonb_typeof(reference.raw_value) = 'string'
    and reference.raw_value #>> '{}'
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
$$;

create or replace function private.lock_valid_asset_references(
  p_value jsonb,
  p_collection_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset_id uuid;
begin
  if exists (
    select 1
    from private.asset_reference_values(p_value) as reference
    where jsonb_typeof(reference.raw_value) is distinct from 'string'
       or reference.raw_value #>> '{}'
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_ASSET_REFERENCE';
  end if;

  for v_asset_id in
    select reference.asset_id
    from private.asset_reference_ids(p_value) as reference
    order by reference.asset_id
  loop
    perform 1
    from app.file_assets as asset
    where asset.id = v_asset_id
      and asset.collection_id = p_collection_id
      and asset.status = 'ready'
    for update;

    if not found then
      raise exception using errcode = '42501', message = 'ASSET_REFERENCE_FORBIDDEN';
    end if;
  end loop;
end;
$$;

create or replace function private.change_asset_reference_counts(
  p_old_value jsonb,
  p_new_value jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  with old_ids as (
    select asset_id
    from private.asset_reference_ids(coalesce(p_old_value, '[]'::jsonb))
  ),
  new_ids as (
    select asset_id
    from private.asset_reference_ids(coalesce(p_new_value, '[]'::jsonb))
  ),
  deltas as (
    select asset_id, -1 as delta
    from old_ids
    where asset_id not in (select asset_id from new_ids)
    union all
    select asset_id, 1 as delta
    from new_ids
    where asset_id not in (select asset_id from old_ids)
  )
  update app.file_assets as asset
  set reference_count = asset.reference_count + deltas.delta
  from deltas
  where asset.id = deltas.asset_id;
end;
$$;

create or replace function private.track_content_asset_references()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_value jsonb := '[]'::jsonb;
  v_new_value jsonb := '[]'::jsonb;
begin
  if tg_table_name = 'units' then
    if tg_op <> 'INSERT' then
      v_old_value := old.documents;
    end if;
    if tg_op <> 'DELETE' then
      v_new_value := new.documents;
    end if;
  elsif tg_table_name = 'unit_revisions' then
    if tg_op <> 'INSERT' then
      v_old_value := coalesce(old.snapshot -> 'documents', '[]'::jsonb);
    end if;
    if tg_op <> 'DELETE' then
      v_new_value := coalesce(new.snapshot -> 'documents', '[]'::jsonb);
    end if;
  elsif tg_table_name = 'lessons' then
    if tg_op <> 'INSERT' then
      v_old_value := old.payload;
    end if;
    if tg_op <> 'DELETE' then
      v_new_value := new.payload;
    end if;
  end if;

  if tg_op <> 'DELETE'
     and (tg_op = 'INSERT' or v_new_value is distinct from v_old_value) then
    perform private.lock_valid_asset_references(
      v_new_value,
      new.collection_id
    );
  end if;

  perform private.change_asset_reference_counts(v_old_value, v_new_value);
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger units_track_asset_references
  after insert or update of documents or delete on app.units
  for each row execute function private.track_content_asset_references();
create trigger unit_revisions_track_asset_references
  after insert or update of snapshot or delete on app.unit_revisions
  for each row execute function private.track_content_asset_references();
create trigger lessons_track_asset_references
  after insert or update of payload or delete on app.lessons
  for each row execute function private.track_content_asset_references();

create or replace function private.prevent_owner_membership_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from app.collections as collection
    where collection.id = old.collection_id
      and collection.owner_id = old.user_id
  )
  and current_setting('app.maintenance_cleanup', true) is distinct from 'on'
  then
    raise exception using
      errcode = '23514',
      message = 'OWNER_CANNOT_LEAVE';
  end if;
  return old;
end;
$$;

create trigger collection_members_preserve_owner
  before delete on app.collection_members
  for each row execute function private.prevent_owner_membership_delete();

create or replace function private.protect_managed_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and old.is_managed
     and current_setting('app.maintenance_cleanup', true) is distinct from 'on'
     and exists (
       select 1
       from app.collections as collection
       where collection.id = old.collection_id
     ) then
    raise exception using
      errcode = '23514',
      message = 'MANAGED_ROLE_CANNOT_BE_DELETED';
  end if;

  if tg_op = 'UPDATE'
     and old.is_managed
     and (
       new.collection_id is distinct from old.collection_id
       or new.name is distinct from old.name
       or new.security_rank is distinct from old.security_rank
       or new.is_managed is distinct from old.is_managed
     ) then
    raise exception using
      errcode = '23514',
      message = 'MANAGED_ROLE_IDENTITY_IS_IMMUTABLE';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger collection_roles_protect_managed
  before update or delete on app.collection_roles
  for each row execute function private.protect_managed_role();

create or replace function private.protect_lesson_immutable_content()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.collection_id is distinct from old.collection_id
     or new.unit_id is distinct from old.unit_id
     or new.unit_revision is distinct from old.unit_revision
     or new.language_code is distinct from old.language_code
     or new.schema_version is distinct from old.schema_version
     or new.payload is distinct from old.payload then
    raise exception using
      errcode = '23514',
      message = 'LESSON_CONTENT_IS_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger lessons_protect_immutable_content
  before update on app.lessons
  for each row execute function private.protect_lesson_immutable_content();

create or replace function private.protect_audit_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Auth deletion may anonymize the actor, but no other audit field may change.
  if tg_op = 'UPDATE'
     and old.actor_user_id is not null
     and new.actor_user_id is null
     and (to_jsonb(new) - 'actor_user_id')
          = (to_jsonb(old) - 'actor_user_id') then
    return new;
  end if;

  if current_setting('app.maintenance_cleanup', true) is distinct from 'on' then
    raise exception using
      errcode = '42501',
      message = 'AUDIT_LOG_IS_APPEND_ONLY';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger collection_audit_logs_append_only
  before update or delete on app.collection_audit_logs
  for each row execute function private.protect_audit_log();

create or replace function private.audit_collection_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_collection_id uuid;
  v_target_id uuid;
begin
  if tg_table_name = 'collections' then
    v_collection_id := (v_row ->> 'id')::uuid;
    v_target_id := v_collection_id;
    if tg_op = 'DELETE' then
      return old;
    end if;
  else
    v_collection_id := nullif(v_row ->> 'collection_id', '')::uuid;
    v_target_id := coalesce(
      nullif(v_row ->> 'id', '')::uuid,
      nullif(v_row ->> 'role_id', '')::uuid,
      nullif(v_row ->> 'invite_id', '')::uuid,
      nullif(v_row ->> 'user_id', '')::uuid
    );
  end if;

  if v_collection_id is not null then
    insert into app.collection_audit_logs (
      collection_id,
      actor_user_id,
      action,
      target_type,
      target_id,
      metadata
    )
    values (
      v_collection_id,
      private.current_user_id(),
      tg_table_name || '.' || lower(tg_op),
      tg_table_name,
      v_target_id,
      jsonb_strip_nulls(jsonb_build_object(
        'revision', v_row -> 'revision',
        'status', v_row -> 'status'
      ))
    );
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger collections_audit
  after insert or update or delete on app.collections
  for each row execute function private.audit_collection_change();
create trigger collection_members_audit
  after insert or update or delete on app.collection_members
  for each row execute function private.audit_collection_change();
create trigger collection_profiles_audit
  after insert or update or delete on app.collection_profiles
  for each row execute function private.audit_collection_change();
create trigger collection_roles_audit
  after insert or update or delete on app.collection_roles
  for each row execute function private.audit_collection_change();
create trigger collection_member_roles_audit
  after insert or update or delete on app.collection_member_roles
  for each row execute function private.audit_collection_change();
create trigger collection_invites_audit
  after insert or update or delete on app.collection_invites
  for each row execute function private.audit_collection_change();
create trigger collection_invite_roles_audit
  after insert or update or delete on app.collection_invite_roles
  for each row execute function private.audit_collection_change();
create trigger units_audit
  after insert or update or delete on app.units
  for each row execute function private.audit_collection_change();
create trigger lessons_audit
  after insert or update or delete on app.lessons
  for each row execute function private.audit_collection_change();

create trigger profiles_touch_updated_at
  before update on app.profiles
  for each row execute function private.touch_updated_at();
create trigger collections_touch_updated_at
  before update on app.collections
  for each row execute function private.touch_updated_at();
create trigger collection_profiles_touch_updated_at
  before update on app.collection_profiles
  for each row execute function private.touch_updated_at();
create trigger collection_roles_touch_updated_at
  before update on app.collection_roles
  for each row execute function private.touch_updated_at();
create trigger settings_touch_updated_at
  before update on app.settings
  for each row execute function private.touch_updated_at();
create trigger units_touch_updated_at
  before update on app.units
  for each row execute function private.touch_updated_at();
create trigger lessons_touch_updated_at
  before update on app.lessons
  for each row execute function private.touch_updated_at();
create trigger lesson_progress_touch_updated_at
  before update on app.lesson_progress
  for each row execute function private.touch_updated_at();
create trigger user_language_stats_touch_updated_at
  before update on app.user_language_stats
  for each row execute function private.touch_updated_at();
create trigger collection_user_language_stats_touch_updated_at
  before update on app.collection_user_language_stats
  for each row execute function private.touch_updated_at();
create trigger user_character_progress_touch_updated_at
  before update on app.user_character_progress
  for each row execute function private.touch_updated_at();
create trigger file_assets_touch_updated_at
  before update on app.file_assets
  for each row execute function private.touch_updated_at();

do $$
declare
  v_table regclass;
begin
  foreach v_table in array array[
    'app.profiles'::regclass,
    'app.username_reservations'::regclass,
    'app.collections'::regclass,
    'app.collection_members'::regclass,
    'app.collection_profiles'::regclass,
    'app.collection_roles'::regclass,
    'app.collection_member_roles'::regclass,
    'app.collection_invites'::regclass,
    'app.collection_invite_roles'::regclass,
    'app.settings'::regclass,
    'app.units'::regclass,
    'app.unit_revisions'::regclass,
    'app.collection_audit_logs'::regclass,
    'app.lessons'::regclass,
    'app.lesson_progress'::regclass,
    'app.progress_batches'::regclass,
    'app.user_language_stats'::regclass,
    'app.collection_user_language_stats'::regclass,
    'app.user_character_progress'::regclass,
    'app.file_assets'::regclass
  ]
  loop
    execute format('alter table %s enable row level security', v_table);
    execute format('alter table %s force row level security', v_table);
  end loop;
end
$$;

create policy profiles_select on app.profiles
  for select to meoing_runtime
  using (private.shares_collection_with(user_id));
create policy profiles_update_own on app.profiles
  for update to meoing_runtime
  using (user_id = private.current_user_id())
  with check (user_id = private.current_user_id());

create policy collections_select_member on app.collections
  for select to meoing_runtime
  using (private.is_collection_member(id));
create policy collections_insert_owner on app.collections
  for insert to meoing_runtime
  with check (owner_id = private.current_user_id());
create policy collections_update_manager on app.collections
  for update to meoing_runtime
  using (private.has_collection_permission(id, 'manage_collection'))
  with check (private.has_collection_permission(id, 'manage_collection'));

create policy collection_members_select_peer on app.collection_members
  for select to meoing_runtime
  using (private.is_collection_member(collection_id));
create policy collection_members_insert_manager on app.collection_members
  for insert to meoing_runtime
  with check (private.has_collection_permission(collection_id, 'manage_members'));
create policy collection_members_delete_manager on app.collection_members
  for delete to meoing_runtime
  using (
    private.has_collection_permission(collection_id, 'manage_members')
    or user_id = private.current_user_id()
  );

create policy collection_profiles_select_member on app.collection_profiles
  for select to meoing_runtime
  using (private.is_collection_member(collection_id));
create policy collection_profiles_insert_allowed on app.collection_profiles
  for insert to meoing_runtime
  with check (
    private.is_collection_member(collection_id)
    and (
      user_id = private.current_user_id()
      or private.has_collection_permission(collection_id, 'manage_collection_profiles')
    )
  );
create policy collection_profiles_update_allowed on app.collection_profiles
  for update to meoing_runtime
  using (
    user_id = private.current_user_id()
    or private.has_collection_permission(collection_id, 'manage_collection_profiles')
  )
  with check (
    user_id = private.current_user_id()
    or private.has_collection_permission(collection_id, 'manage_collection_profiles')
  );
create policy collection_profiles_delete_allowed on app.collection_profiles
  for delete to meoing_runtime
  using (
    user_id = private.current_user_id()
    or private.has_collection_permission(collection_id, 'manage_collection_profiles')
  );

create policy collection_roles_select_member on app.collection_roles
  for select to meoing_runtime
  using (private.is_collection_member(collection_id));
create policy collection_roles_insert_manager on app.collection_roles
  for insert to meoing_runtime
  with check (private.has_collection_permission(collection_id, 'manage_roles'));
create policy collection_roles_update_manager on app.collection_roles
  for update to meoing_runtime
  using (private.has_collection_permission(collection_id, 'manage_roles'))
  with check (private.has_collection_permission(collection_id, 'manage_roles'));
create policy collection_roles_delete_manager on app.collection_roles
  for delete to meoing_runtime
  using (private.has_collection_permission(collection_id, 'manage_roles'));

create policy collection_member_roles_select_member on app.collection_member_roles
  for select to meoing_runtime
  using (private.is_collection_member(collection_id));
create policy collection_member_roles_insert_manager on app.collection_member_roles
  for insert to meoing_runtime
  with check (private.has_collection_permission(collection_id, 'manage_roles'));
create policy collection_member_roles_delete_manager on app.collection_member_roles
  for delete to meoing_runtime
  using (private.has_collection_permission(collection_id, 'manage_roles'));

create policy collection_invites_select_manager on app.collection_invites
  for select to meoing_runtime
  using (private.has_collection_permission(collection_id, 'manage_invites'));
create policy collection_invites_insert_manager on app.collection_invites
  for insert to meoing_runtime
  with check (private.has_collection_permission(collection_id, 'manage_invites'));
create policy collection_invites_update_manager on app.collection_invites
  for update to meoing_runtime
  using (private.has_collection_permission(collection_id, 'manage_invites'))
  with check (private.has_collection_permission(collection_id, 'manage_invites'));
create policy collection_invites_delete_manager on app.collection_invites
  for delete to meoing_runtime
  using (private.has_collection_permission(collection_id, 'manage_invites'));

create policy collection_invite_roles_select_manager on app.collection_invite_roles
  for select to meoing_runtime
  using (private.has_collection_permission(collection_id, 'manage_invites'));
create policy collection_invite_roles_insert_manager on app.collection_invite_roles
  for insert to meoing_runtime
  with check (private.has_collection_permission(collection_id, 'manage_invites'));
create policy collection_invite_roles_delete_manager on app.collection_invite_roles
  for delete to meoing_runtime
  using (private.has_collection_permission(collection_id, 'manage_invites'));

create policy settings_select_allowed on app.settings
  for select to meoing_runtime
  using (
    (scope_type = 'user' and user_id = private.current_user_id())
    or (
      scope_type = 'collection'
      and private.is_collection_member(collection_id)
    )
    or (
      scope_type = 'collection_user'
      and (
        user_id = private.current_user_id()
        or private.has_collection_permission(collection_id, 'manage_members')
      )
    )
  );
create policy settings_insert_allowed on app.settings
  for insert to meoing_runtime
  with check (
    (scope_type = 'user' and user_id = private.current_user_id())
    or (
      scope_type = 'collection'
      and private.has_collection_permission(collection_id, 'manage_collection')
    )
    or (
      scope_type = 'collection_user'
      and user_id = private.current_user_id()
      and private.is_collection_member(collection_id)
    )
  );
create policy settings_update_allowed on app.settings
  for update to meoing_runtime
  using (
    (scope_type = 'user' and user_id = private.current_user_id())
    or (
      scope_type = 'collection'
      and private.has_collection_permission(collection_id, 'manage_collection')
    )
    or (
      scope_type = 'collection_user'
      and user_id = private.current_user_id()
      and private.is_collection_member(collection_id)
    )
  )
  with check (
    (scope_type = 'user' and user_id = private.current_user_id())
    or (
      scope_type = 'collection'
      and private.has_collection_permission(collection_id, 'manage_collection')
    )
    or (
      scope_type = 'collection_user'
      and user_id = private.current_user_id()
      and private.is_collection_member(collection_id)
    )
  );
create policy settings_delete_allowed on app.settings
  for delete to meoing_runtime
  using (
    (scope_type = 'user' and user_id = private.current_user_id())
    or (
      scope_type = 'collection'
      and private.has_collection_permission(collection_id, 'manage_collection')
    )
    or (
      scope_type = 'collection_user'
      and user_id = private.current_user_id()
      and private.is_collection_member(collection_id)
    )
  );

create policy units_select_member on app.units
  for select to meoing_runtime
  using (private.is_collection_member(collection_id));
create policy units_insert_creator on app.units
  for insert to meoing_runtime
  with check (
    created_by = private.current_user_id()
    and private.has_collection_permission(collection_id, 'create_content')
  );
create policy units_update_editor on app.units
  for update to meoing_runtime
  using (private.has_collection_permission(collection_id, 'edit_content'))
  with check (private.has_collection_permission(collection_id, 'edit_content'));
create policy units_delete_editor on app.units
  for delete to meoing_runtime
  using (private.has_collection_permission(collection_id, 'delete_content'));

create policy unit_revisions_select_member on app.unit_revisions
  for select to meoing_runtime
  using (private.is_collection_member(collection_id));
create policy unit_revisions_insert_editor on app.unit_revisions
  for insert to meoing_runtime
  with check (
    created_by = private.current_user_id()
    and (
      private.has_collection_permission(collection_id, 'create_content')
      or private.has_collection_permission(collection_id, 'edit_content')
    )
  );

create policy collection_audit_logs_select_viewer on app.collection_audit_logs
  for select to meoing_runtime
  using (private.has_collection_permission(collection_id, 'view_audit_log'));

create policy lessons_select_allowed on app.lessons
  for select to meoing_runtime
  using (
    private.is_collection_member(collection_id)
    and (
      status = 'published'
      or created_by = private.current_user_id()
      or private.has_collection_permission(collection_id, 'publish_lessons')
    )
  );
create policy lessons_insert_creator on app.lessons
  for insert to meoing_runtime
  with check (
    created_by = private.current_user_id()
    and private.has_collection_permission(collection_id, 'create_lessons')
  );
create policy lessons_update_allowed on app.lessons
  for update to meoing_runtime
  using (
    (status = 'draft' and created_by = private.current_user_id())
    or private.has_collection_permission(collection_id, 'publish_lessons')
  )
  with check (
    (created_by = private.current_user_id())
    or private.has_collection_permission(collection_id, 'publish_lessons')
  );
create policy lessons_delete_allowed on app.lessons
  for delete to meoing_runtime
  using (
    (status = 'draft' and created_by = private.current_user_id())
    or private.has_collection_permission(collection_id, 'delete_content')
  );

create policy lesson_progress_select_own on app.lesson_progress
  for select to meoing_runtime
  using (user_id = private.current_user_id());
create policy lesson_progress_insert_own on app.lesson_progress
  for insert to meoing_runtime
  with check (
    user_id = private.current_user_id()
    and private.is_collection_member(collection_id)
  );
create policy lesson_progress_update_own on app.lesson_progress
  for update to meoing_runtime
  using (user_id = private.current_user_id())
  with check (user_id = private.current_user_id());

create policy progress_batches_select_own on app.progress_batches
  for select to meoing_runtime
  using (user_id = private.current_user_id());
create policy progress_batches_insert_own on app.progress_batches
  for insert to meoing_runtime
  with check (user_id = private.current_user_id());

create policy user_language_stats_own on app.user_language_stats
  for all to meoing_runtime
  using (user_id = private.current_user_id())
  with check (user_id = private.current_user_id());

create policy collection_user_language_stats_select_allowed
  on app.collection_user_language_stats
  for select to meoing_runtime
  using (
    user_id = private.current_user_id()
    or private.has_collection_permission(collection_id, 'view_member_progress')
  );
create policy collection_user_language_stats_write_own
  on app.collection_user_language_stats
  for all to meoing_runtime
  using (user_id = private.current_user_id())
  with check (
    user_id = private.current_user_id()
    and private.is_collection_member(collection_id)
  );

create policy user_character_progress_own on app.user_character_progress
  for all to meoing_runtime
  using (user_id = private.current_user_id())
  with check (user_id = private.current_user_id());

create policy file_assets_select_allowed on app.file_assets
  for select to meoing_runtime
  using (
    owner_id = private.current_user_id()
    or (
      collection_id is not null
      and private.is_collection_member(collection_id)
    )
  );
create policy file_assets_insert_own on app.file_assets
  for insert to meoing_runtime
  with check (
    owner_id = private.current_user_id()
    and (
      collection_id is null
      or private.is_collection_member(collection_id)
    )
  );
create policy file_assets_update_own on app.file_assets
  for update to meoing_runtime
  using (owner_id = private.current_user_id())
  with check (owner_id = private.current_user_id());
create policy file_assets_delete_own on app.file_assets
  for delete to meoing_runtime
  using (owner_id = private.current_user_id());

grant usage on schema app, private to meoing_runtime;

grant select on app.profiles to meoing_runtime;
grant select on app.collections to meoing_runtime;
grant select on app.collection_members to meoing_runtime;
grant select on app.collection_profiles to meoing_runtime;
grant select on app.collection_roles to meoing_runtime;
grant select on app.collection_member_roles to meoing_runtime;
grant select on app.collection_invites to meoing_runtime;
grant select on app.collection_invite_roles to meoing_runtime;
grant select on app.settings to meoing_runtime;
grant select on app.units to meoing_runtime;
grant select on app.unit_revisions to meoing_runtime;
grant select on app.collection_audit_logs to meoing_runtime;
grant select on app.lessons to meoing_runtime;
grant select on app.lesson_progress to meoing_runtime;
grant select on app.progress_batches to meoing_runtime;
grant select on app.user_language_stats to meoing_runtime;
grant select on app.collection_user_language_stats to meoing_runtime;
grant select on app.user_character_progress to meoing_runtime;
grant select on app.file_assets to meoing_runtime;

revoke all on all tables in schema app from public, anon, authenticated;
revoke all on all sequences in schema app from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

revoke execute on all functions in schema private from public;
grant execute on function private.current_user_id() to meoing_runtime;
grant execute on function private.require_user() to meoing_runtime;
grant execute on function private.require_active_user() to meoing_runtime;
grant execute on function private.is_collection_member(uuid) to meoing_runtime;
grant execute on function private.is_collection_owner(uuid) to meoing_runtime;
grant execute on function private.has_collection_permission(uuid, text) to meoing_runtime;
grant execute on function private.max_security_rank(uuid) to meoing_runtime;
grant execute on function private.shares_collection_with(uuid) to meoing_runtime;

alter default privileges in schema app revoke all on tables from public, anon, authenticated;
alter default privileges in schema app revoke all on sequences from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;

comment on role meoing_runtime is
  'NOLOGIN capability role. Grant to the dedicated Hyperdrive login and SET ROLE per transaction.';
comment on role meoing_maintenance is
  'NOLOGIN capability role for the Cron-only maintenance database login.';

commit;

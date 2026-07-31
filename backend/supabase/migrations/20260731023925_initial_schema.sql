begin;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pgtap with schema extensions;

create schema if not exists app;
create schema if not exists private;

revoke all on schema app from public, anon, authenticated;
revoke all on schema private from public, anon, authenticated;

create table private.rate_limit_buckets (
  scope text not null,
  abuse_key bytea not null,
  window_started_at timestamptz not null,
  request_count integer not null,
  expires_at timestamptz not null,
  primary key (scope, abuse_key, window_started_at),
  constraint rate_limit_buckets_scope check (
    scope in ('username_lookup', 'invite_accept')
  ),
  constraint rate_limit_buckets_key_length check (octet_length(abuse_key) = 32),
  constraint rate_limit_buckets_count_positive check (request_count > 0),
  constraint rate_limit_buckets_expiry check (expires_at > window_started_at)
);

create index rate_limit_buckets_expiry_idx
  on private.rate_limit_buckets (expires_at, scope);

revoke all on table private.rate_limit_buckets
  from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'meoing_runtime') then
    create role meoing_runtime
      nologin
      nosuperuser
      nocreatedb
      nocreaterole
      noinherit
      noreplication
      nobypassrls;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'meoing_maintenance') then
    create role meoing_maintenance
      nologin
      nosuperuser
      nocreatedb
      nocreaterole
      noinherit
      noreplication
      nobypassrls;
  end if;
end
$$;

create or replace function private.normalize_surface(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(
    btrim(normalize(coalesce(p_value, ''), NFC)),
    '[[:space:]]+',
    ' ',
    'g'
  );
$$;

create or replace function private.normalize_prose(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select btrim(normalize(coalesce(p_value, ''), NFC));
$$;

create or replace function private.is_normalized_unique_string_array(p_value jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
begin
  if jsonb_typeof(p_value) is distinct from 'array' then
    return false;
  end if;

  return not exists (
      select 1
      from jsonb_array_elements(p_value) as item(value)
      where jsonb_typeof(item.value) is distinct from 'string'
         or private.normalize_surface(item.value #>> '{}') = ''
         or private.normalize_surface(item.value #>> '{}')
              is distinct from item.value #>> '{}'
    )
    and (
      select count(*)
      from jsonb_array_elements_text(p_value)
    ) = (
      select count(distinct value)
      from jsonb_array_elements_text(p_value) as item(value)
    );
end;
$$;

create or replace function private.term_surface(p_item jsonb)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case jsonb_typeof(p_item)
    when 'string' then p_item #>> '{}'
    when 'object' then p_item ->> 'text'
    else null
  end;
$$;

create or replace function private.is_normalized_unique_term_array(p_value jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
begin
  if jsonb_typeof(p_value) is distinct from 'array' then
    return false;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_value) as item(value)
    where coalesce(jsonb_typeof(item.value), '') not in ('string', 'object')
       or private.term_surface(item.value) is null
       or private.normalize_surface(private.term_surface(item.value)) = ''
       or private.normalize_surface(private.term_surface(item.value))
            is distinct from private.term_surface(item.value)
       or char_length(private.term_surface(item.value)) > 5000
       or (
         jsonb_typeof(item.value) = 'object'
         and (
           item.value ? 'id'
           or jsonb_typeof(item.value -> 'text') is distinct from 'string'
           or (
             item.value ? 'translation'
             and jsonb_typeof(item.value -> 'translation') is distinct from 'string'
           )
           or (
             item.value ? 'notes'
             and jsonb_typeof(item.value -> 'notes') is distinct from 'string'
           )
           or (
             item.value ? 'translation'
             and (
               private.normalize_surface(item.value ->> 'translation')
                 is distinct from item.value ->> 'translation'
               or char_length(item.value ->> 'translation') > 5000
             )
           )
           or (
             item.value ? 'notes'
             and (
               private.normalize_surface(item.value ->> 'notes')
                 is distinct from item.value ->> 'notes'
               or char_length(item.value ->> 'notes') > 5000
             )
           )
         )
       )
  ) then
    return false;
  end if;

  return (
    select count(*)
    from jsonb_array_elements(p_value)
  ) = (
    select count(distinct private.term_surface(item.value))
    from jsonb_array_elements(p_value) as item(value)
  );
end;
$$;

create or replace function private.is_valid_documents(p_value jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
begin
  if jsonb_typeof(p_value) is distinct from 'array' then
    return false;
  end if;

  return not exists (
    select 1
    from jsonb_array_elements(p_value) as document(value)
    where jsonb_typeof(document.value) is distinct from 'object'
       or document.value ? 'id'
       or jsonb_typeof(document.value -> 'title') is distinct from 'string'
       or char_length(document.value ->> 'title') > 200
       or private.normalize_surface(document.value ->> 'title')
            is distinct from document.value ->> 'title'
       or jsonb_typeof(document.value -> 'content') is distinct from 'object'
  );
end;
$$;

create or replace function private.valid_permissions(p_permissions text[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select
    p_permissions <@ array[
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
    ]::text[]
    and cardinality(p_permissions) = (
      select count(distinct permission)
      from unnest(p_permissions) as permission
    );
$$;

create table app.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text,
  display_name text not null default 'Meoing User',
  avatar_asset_id uuid,
  bio text,
  revision bigint not null default 1,
  username_changed_at timestamptz,
  deletion_requested_at timestamptz,
  delete_after timestamptz,
  api_locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_format check (
    username is null
    or (
      username = lower(username)
      and char_length(username) between 3 and 32
      and username ~ '^[a-z0-9._]+$'
      and strpos(username, '..') = 0
    )
  ),
  constraint profiles_display_name_length check (
    char_length(display_name) between 1 and 64
  ),
  constraint profiles_bio_length check (bio is null or char_length(bio) <= 500),
  constraint profiles_revision_positive check (revision > 0),
  constraint profiles_deletion_state check (
    (deletion_requested_at is null and delete_after is null and api_locked_at is null)
    or (
      deletion_requested_at is not null
      and delete_after is not null
      and api_locked_at is not null
      and delete_after > deletion_requested_at
    )
  )
);

create unique index profiles_username_unique_idx
  on app.profiles (username)
  where username is not null;

create index profiles_deletion_due_idx
  on app.profiles (delete_after, user_id)
  where delete_after is not null;

create table app.username_reservations (
  username text primary key,
  reservation_type text not null,
  user_id uuid references auth.users(id) on delete cascade,
  expires_at timestamptz,
  reason text,
  created_at timestamptz not null default now(),
  constraint username_reservations_format check (
    username = lower(username)
    and char_length(username) between 3 and 32
    and username ~ '^[a-z0-9._]+$'
    and strpos(username, '..') = 0
  ),
  constraint username_reservations_type check (
    reservation_type in ('permanent', 'released')
  ),
  constraint username_reservations_shape check (
    (reservation_type = 'permanent' and user_id is null and expires_at is null)
    or (reservation_type = 'released' and user_id is not null and expires_at is not null)
  )
);

create index username_reservations_expiry_idx
  on app.username_reservations (expires_at)
  where expires_at is not null;

create table app.collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  name text not null,
  description text,
  idempotency_key text,
  revision bigint not null default 1,
  deleted_at timestamptz,
  delete_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint collections_name_length check (char_length(name) between 1 and 100),
  constraint collections_description_length check (
    description is null or char_length(description) <= 1000
  ),
  constraint collections_idempotency_key_length check (
    idempotency_key is null or char_length(idempotency_key) between 16 and 255
  ),
  constraint collections_revision_positive check (revision > 0),
  constraint collections_deletion_state check (
    (deleted_at is null and delete_after is null)
    or (deleted_at is not null and delete_after is not null and delete_after > deleted_at)
  )
);

create index collections_owner_idx on app.collections (owner_id);
create unique index collections_idempotency_unique_idx
  on app.collections (owner_id, idempotency_key)
  where idempotency_key is not null;
create index collections_delete_due_idx
  on app.collections (delete_after, id)
  where delete_after is not null;

create table app.collection_members (
  collection_id uuid not null references app.collections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  invited_by uuid references auth.users(id) on delete set null,
  accepted_invite_id uuid,
  accept_idempotency_key text,
  joined_at timestamptz not null default now(),
  primary key (collection_id, user_id),
  constraint collection_members_accept_idempotency_length check (
    accept_idempotency_key is null
    or char_length(accept_idempotency_key) between 16 and 255
  ),
  constraint collection_members_accept_shape check (
    (
      accepted_invite_id is null
      and accept_idempotency_key is null
    )
    or (
      accepted_invite_id is not null
      and accept_idempotency_key is not null
    )
  )
);

create index collection_members_user_collection_idx
  on app.collection_members (user_id, collection_id);
create unique index collection_members_accept_idempotency_idx
  on app.collection_members (user_id, accept_idempotency_key)
  where accept_idempotency_key is not null;

create table app.collection_profiles (
  collection_id uuid not null,
  user_id uuid not null,
  display_name text,
  avatar_asset_id uuid,
  bio text,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (collection_id, user_id),
  foreign key (collection_id, user_id)
    references app.collection_members(collection_id, user_id)
    on delete cascade,
  constraint collection_profiles_display_name_length check (
    display_name is null or char_length(display_name) between 1 and 64
  ),
  constraint collection_profiles_bio_length check (
    bio is null or char_length(bio) <= 500
  ),
  constraint collection_profiles_revision_positive check (revision > 0)
);

create index collection_profiles_user_idx
  on app.collection_profiles (user_id, collection_id);

create table app.collection_roles (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references app.collections(id) on delete cascade,
  name text not null,
  color text,
  permissions text[] not null default '{}',
  security_rank integer not null default 0,
  is_managed boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  idempotency_key text,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (collection_id, id),
  constraint collection_roles_name_length check (char_length(name) between 1 and 100),
  constraint collection_roles_color check (
    color is null or color ~ '^#[0-9A-Fa-f]{6}$'
  ),
  constraint collection_roles_idempotency_key_length check (
    idempotency_key is null or char_length(idempotency_key) between 16 and 255
  ),
  constraint collection_roles_permissions_valid check (
    private.valid_permissions(permissions)
  ),
  constraint collection_roles_security_rank check (security_rank between 0 and 10000),
  constraint collection_roles_revision_positive check (revision > 0),
  constraint collection_roles_managed_shape check (
    not is_managed
    or (
      name = '@everyone'
      and security_rank = 0
    )
  )
);

create unique index collection_roles_name_unique_idx
  on app.collection_roles (collection_id, lower(name));

create unique index collection_roles_everyone_unique_idx
  on app.collection_roles (collection_id)
  where is_managed;

create index collection_roles_collection_rank_idx
  on app.collection_roles (collection_id, security_rank desc, id);
create unique index collection_roles_idempotency_unique_idx
  on app.collection_roles (collection_id, created_by, idempotency_key)
  where idempotency_key is not null;

create table app.collection_member_roles (
  collection_id uuid not null,
  user_id uuid not null,
  role_id uuid not null,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (collection_id, user_id, role_id),
  foreign key (collection_id, user_id)
    references app.collection_members(collection_id, user_id)
    on delete cascade,
  foreign key (collection_id, role_id)
    references app.collection_roles(collection_id, id)
    on delete cascade
);

create index collection_member_roles_role_idx
  on app.collection_member_roles (collection_id, role_id, user_id);

create table app.collection_invites (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references app.collections(id) on delete cascade,
  token_hash bytea not null unique,
  token_hint text,
  created_by uuid references auth.users(id) on delete set null,
  idempotency_key text,
  expires_at timestamptz,
  max_uses integer,
  uses_count integer not null default 0,
  revoked_at timestamptz,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  unique (id, collection_id),
  constraint collection_invites_token_hash_length check (octet_length(token_hash) = 32),
  constraint collection_invites_idempotency_key_length check (
    idempotency_key is null or char_length(idempotency_key) between 16 and 255
  ),
  constraint collection_invites_token_hint_length check (
    token_hint is null or char_length(token_hint) between 4 and 12
  ),
  constraint collection_invites_max_uses_positive check (
    max_uses is null or max_uses > 0
  ),
  constraint collection_invites_uses_count_valid check (
    uses_count >= 0 and (max_uses is null or uses_count <= max_uses)
  ),
  constraint collection_invites_revision_positive check (revision > 0)
);

create index collection_invites_collection_created_idx
  on app.collection_invites (collection_id, created_at desc, id);
create unique index collection_invites_idempotency_unique_idx
  on app.collection_invites (collection_id, created_by, idempotency_key)
  where idempotency_key is not null;

create index collection_invites_active_idx
  on app.collection_invites (expires_at, id)
  where revoked_at is null;

create table app.collection_invite_roles (
  invite_id uuid not null,
  collection_id uuid not null,
  role_id uuid not null,
  primary key (invite_id, role_id),
  foreign key (invite_id, collection_id)
    references app.collection_invites(id, collection_id)
    on delete cascade,
  foreign key (collection_id, role_id)
    references app.collection_roles(collection_id, id)
    on delete cascade
);

create index collection_invite_roles_role_idx
  on app.collection_invite_roles (collection_id, role_id, invite_id);

create table app.settings (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null,
  user_id uuid references auth.users(id) on delete cascade,
  collection_id uuid references app.collections(id) on delete cascade,
  key text not null,
  value jsonb not null,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint settings_scope_type check (
    scope_type in ('user', 'collection', 'collection_user')
  ),
  constraint settings_scope_shape check (
    (scope_type = 'user' and user_id is not null and collection_id is null)
    or (scope_type = 'collection' and user_id is null and collection_id is not null)
    or (scope_type = 'collection_user' and user_id is not null and collection_id is not null)
  ),
  constraint settings_key_format check (
    char_length(key) between 1 and 100
    and key ~ '^[a-z][a-z0-9_.-]*$'
  ),
  constraint settings_value_not_null check (jsonb_typeof(value) <> 'null'),
  constraint settings_value_size check (octet_length(value::text) <= 65536),
  constraint settings_revision_positive check (revision > 0)
);

create unique index settings_user_unique_idx
  on app.settings (user_id, key)
  where scope_type = 'user';

create unique index settings_collection_unique_idx
  on app.settings (collection_id, key)
  where scope_type = 'collection';

create unique index settings_collection_user_unique_idx
  on app.settings (collection_id, user_id, key)
  where scope_type = 'collection_user';

create index settings_user_collection_idx
  on app.settings (user_id, collection_id, key);

create table app.units (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references app.collections(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  idempotency_key text,
  name text not null,
  description text,
  instruction_override text,
  language_code text not null,
  words jsonb not null default '[]',
  phrases jsonb not null default '[]',
  sentences jsonb not null default '[]',
  documents jsonb not null default '[]',
  revision bigint not null default 1,
  deleted_at timestamptz,
  delete_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint units_name_length check (char_length(name) between 1 and 200),
  constraint units_description_length check (
    description is null or char_length(description) <= 5000
  ),
  constraint units_instruction_override_length check (
    instruction_override is null or char_length(instruction_override) <= 20000
  ),
  constraint units_idempotency_key_length check (
    idempotency_key is null or char_length(idempotency_key) between 16 and 255
  ),
  constraint units_language_code check (
    char_length(language_code) between 2 and 35
    and language_code ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
  ),
  constraint units_words_shape check (
    private.is_normalized_unique_term_array(words)
  ),
  constraint units_phrases_shape check (
    private.is_normalized_unique_term_array(phrases)
  ),
  constraint units_sentences_shape check (
    private.is_normalized_unique_term_array(sentences)
  ),
  constraint units_documents_shape check (private.is_valid_documents(documents)),
  constraint units_content_size check (
    octet_length(
      jsonb_build_object(
        'words', words,
        'phrases', phrases,
        'sentences', sentences,
        'documents', documents
      )::text
    ) <= 1048576
  ),
  constraint units_revision_positive check (revision > 0),
  constraint units_deletion_state check (
    (deleted_at is null and delete_after is null)
    or (deleted_at is not null and delete_after is not null and delete_after > deleted_at)
  )
);

create index units_collection_active_idx
  on app.units (collection_id, updated_at desc, id)
  where deleted_at is null;
create unique index units_idempotency_unique_idx
  on app.units (collection_id, created_by, idempotency_key)
  where idempotency_key is not null;

create index units_delete_due_idx
  on app.units (delete_after, id)
  where delete_after is not null;

create table app.unit_revisions (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references app.units(id) on delete cascade,
  collection_id uuid not null references app.collections(id) on delete cascade,
  revision bigint not null,
  snapshot jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  action text not null,
  created_at timestamptz not null default now(),
  unique (unit_id, revision),
  constraint unit_revisions_revision_positive check (revision > 0),
  constraint unit_revisions_action check (
    action in ('created', 'updated', 'restored', 'deleted', 'undeleted')
  ),
  constraint unit_revisions_snapshot_object check (jsonb_typeof(snapshot) = 'object')
);

create index unit_revisions_unit_created_idx
  on app.unit_revisions (unit_id, created_at desc, id);

create index unit_revisions_collection_created_idx
  on app.unit_revisions (collection_id, created_at desc, id);

create table app.collection_audit_logs (
  id bigint generated always as identity primary key,
  -- Deliberately no FK: a collection purge keeps its audit tombstone until day 90.
  collection_id uuid not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id uuid,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint collection_audit_logs_action_length check (
    char_length(action) between 1 and 80
  ),
  constraint collection_audit_logs_target_type_length check (
    char_length(target_type) between 1 and 40
  ),
  constraint collection_audit_logs_metadata_object check (
    jsonb_typeof(metadata) = 'object'
  ),
  constraint collection_audit_logs_metadata_size check (
    octet_length(metadata::text) <= 65536
  )
);

create index collection_audit_logs_cursor_idx
  on app.collection_audit_logs (collection_id, created_at desc, id desc);

create index collection_audit_logs_retention_idx
  on app.collection_audit_logs (created_at, id);

create table app.lessons (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references app.collections(id) on delete cascade,
  unit_id uuid not null references app.units(id) on delete cascade,
  unit_revision bigint not null,
  created_by uuid references auth.users(id) on delete set null,
  idempotency_key text,
  title text not null,
  language_code text not null,
  schema_version integer not null default 8,
  payload jsonb not null,
  status text not null default 'draft',
  revision bigint not null default 1,
  published_at timestamptz,
  published_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (unit_id, unit_revision, id),
  constraint lessons_title_length check (char_length(title) between 1 and 200),
  constraint lessons_idempotency_key_length check (
    idempotency_key is null or char_length(idempotency_key) between 16 and 255
  ),
  constraint lessons_language_code check (
    char_length(language_code) between 2 and 35
    and language_code ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
  ),
  constraint lessons_schema_version check (schema_version = 8),
  constraint lessons_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint lessons_payload_size check (octet_length(payload::text) <= 1048576),
  constraint lessons_status check (status in ('draft', 'published')),
  constraint lessons_publish_state check (
    (status = 'draft' and published_at is null and published_by is null)
    or (status = 'published' and published_at is not null)
  ),
  constraint lessons_revision_positive check (revision > 0)
);

create index lessons_collection_status_cursor_idx
  on app.lessons (collection_id, status, created_at desc, id);
create unique index lessons_idempotency_unique_idx
  on app.lessons (collection_id, created_by, idempotency_key)
  where idempotency_key is not null;

create index lessons_creator_draft_idx
  on app.lessons (created_by, created_at desc, id)
  where status = 'draft' and deleted_at is null;

create table app.lesson_progress (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references app.lessons(id) on delete cascade,
  collection_id uuid not null references app.collections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  start_idempotency_key text,
  language_code text not null,
  status text not null default 'in_progress',
  summary jsonb not null default '{}',
  attempts jsonb not null default '[]',
  revision bigint not null default 1,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  raw_expires_at timestamptz not null default (now() + interval '1 year'),
  updated_at timestamptz not null default now(),
  constraint lesson_progress_language_code check (
    char_length(language_code) between 2 and 35
    and language_code ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
  ),
  constraint lesson_progress_start_idempotency_length check (
    start_idempotency_key is null
    or char_length(start_idempotency_key) between 16 and 255
  ),
  constraint lesson_progress_status check (
    status in ('in_progress', 'completed', 'abandoned')
  ),
  constraint lesson_progress_summary_object check (jsonb_typeof(summary) = 'object'),
  constraint lesson_progress_attempts_array check (jsonb_typeof(attempts) = 'array'),
  constraint lesson_progress_completed_state check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  ),
  constraint lesson_progress_revision_positive check (revision > 0),
  constraint lesson_progress_raw_expiry check (raw_expires_at > started_at)
);

create index lesson_progress_user_cursor_idx
  on app.lesson_progress (user_id, started_at desc, id);
create unique index lesson_progress_start_idempotency_idx
  on app.lesson_progress (user_id, start_idempotency_key)
  where start_idempotency_key is not null;

create index lesson_progress_collection_user_cursor_idx
  on app.lesson_progress (collection_id, user_id, started_at desc, id);

create index lesson_progress_raw_expiry_idx
  on app.lesson_progress (raw_expires_at, id)
  where attempts <> '[]'::jsonb;

create table app.progress_batches (
  batch_id uuid primary key,
  progress_id uuid not null references app.lesson_progress(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  payload_hash bytea not null,
  result jsonb not null,
  processed_at timestamptz not null default now(),
  constraint progress_batches_hash_length check (octet_length(payload_hash) = 32),
  constraint progress_batches_result_object check (jsonb_typeof(result) = 'object')
);

create index progress_batches_progress_idx
  on app.progress_batches (progress_id, processed_at desc);

create index progress_batches_user_idx
  on app.progress_batches (user_id, processed_at desc);

create table app.user_language_stats (
  user_id uuid not null references auth.users(id) on delete cascade,
  language_code text not null,
  words jsonb not null default '{}',
  phrases jsonb not null default '{}',
  sentences jsonb not null default '{}',
  aggregate jsonb not null default '{}',
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, language_code),
  constraint user_language_stats_language_code check (
    char_length(language_code) between 2 and 35
    and language_code ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
  ),
  constraint user_language_stats_json_objects check (
    jsonb_typeof(words) = 'object'
    and jsonb_typeof(phrases) = 'object'
    and jsonb_typeof(sentences) = 'object'
    and jsonb_typeof(aggregate) = 'object'
  ),
  constraint user_language_stats_revision_positive check (revision > 0)
);

create table app.collection_user_language_stats (
  collection_id uuid not null references app.collections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  language_code text not null,
  words jsonb not null default '{}',
  phrases jsonb not null default '{}',
  sentences jsonb not null default '{}',
  aggregate jsonb not null default '{}',
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (collection_id, user_id, language_code),
  constraint collection_user_language_stats_language_code check (
    char_length(language_code) between 2 and 35
    and language_code ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
  ),
  constraint collection_user_language_stats_json_objects check (
    jsonb_typeof(words) = 'object'
    and jsonb_typeof(phrases) = 'object'
    and jsonb_typeof(sentences) = 'object'
    and jsonb_typeof(aggregate) = 'object'
  ),
  constraint collection_user_language_stats_revision_positive check (revision > 0)
);

create index collection_user_language_stats_user_idx
  on app.collection_user_language_stats (user_id, language_code, collection_id);

create table app.user_character_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  language_code text not null,
  characters jsonb not null default '{}',
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, language_code),
  constraint user_character_progress_language_code check (
    char_length(language_code) between 2 and 35
    and language_code ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
  ),
  constraint user_character_progress_characters_object check (
    jsonb_typeof(characters) = 'object'
  ),
  constraint user_character_progress_characters_size check (
    octet_length(characters::text) <= 1048576
  ),
  constraint user_character_progress_revision_positive check (revision > 0)
);

create table app.file_assets (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid references app.collections(id) on delete cascade,
  owner_id uuid references auth.users(id) on delete set null,
  idempotency_key text,
  r2_key text not null unique,
  original_filename text not null,
  mime_type text not null,
  expected_size_bytes bigint not null,
  expected_sha256 bytea not null,
  size_bytes bigint,
  sha256 bytea,
  etag text,
  uploaded_at timestamptz,
  status text not null default 'pending',
  metadata jsonb not null default '{}',
  reference_count integer not null default 0,
  pending_expires_at timestamptz not null default (now() + interval '24 hours'),
  ready_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint file_assets_r2_key_length check (char_length(r2_key) between 1 and 512),
  constraint file_assets_owner_scope check (
    owner_id is not null or collection_id is not null
  ),
  constraint file_assets_idempotency_key_length check (
    idempotency_key is null or char_length(idempotency_key) between 16 and 255
  ),
  constraint file_assets_filename_length check (
    char_length(original_filename) between 1 and 255
  ),
  constraint file_assets_mime_type check (
    mime_type in (
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
      'application/pdf',
      'text/plain',
      'text/markdown',
      'text/html'
    )
  ),
  constraint file_assets_size check (
    expected_size_bytes between 1 and 26214400
    and (size_bytes is null or size_bytes between 1 and 26214400)
  ),
  constraint file_assets_sha256_length check (
    octet_length(expected_sha256) = 32
    and (sha256 is null or octet_length(sha256) = 32)
  ),
  constraint file_assets_etag_length check (etag is null or char_length(etag) <= 128),
  constraint file_assets_status check (
    status in ('pending', 'ready', 'deleted')
  ),
  constraint file_assets_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint file_assets_reference_count check (reference_count >= 0),
  constraint file_assets_state_shape check (
    (
      status = 'pending'
      and size_bytes is null
      and sha256 is null
      and etag is null
      and uploaded_at is null
      and ready_at is null
      and deleted_at is null
    )
    or (
      status = 'ready'
      and size_bytes is not null
      and sha256 is not null
      and etag is not null
      and uploaded_at is not null
      and ready_at is not null
      and deleted_at is null
    )
    or (
      status = 'deleted'
      and deleted_at is not null
    )
  )
);

create index file_assets_owner_status_idx
  on app.file_assets (owner_id, status, created_at desc, id);
create unique index file_assets_idempotency_unique_idx
  on app.file_assets (owner_id, idempotency_key)
  where idempotency_key is not null;

create index file_assets_collection_status_idx
  on app.file_assets (collection_id, status, created_at desc, id)
  where collection_id is not null;

create index file_assets_pending_expiry_idx
  on app.file_assets (pending_expires_at, id)
  where status = 'pending';

alter table app.profiles
  add constraint profiles_avatar_asset_fkey
  foreign key (avatar_asset_id) references app.file_assets(id) on delete set null;

alter table app.collection_profiles
  add constraint collection_profiles_avatar_asset_fkey
  foreign key (avatar_asset_id) references app.file_assets(id) on delete set null;

comment on schema app is
  'Meoing application data. Not exposed through Supabase Data API.';
comment on schema private is
  'Internal helpers and Worker-only RPCs. Never expose through PostgREST.';
comment on column app.units.words is
  'Normalized, unique JSON array of strings or metadata objects keyed by text. Items intentionally have no IDs.';
comment on column app.units.documents is
  'JSON array of objects with title and Lexical content. Documents intentionally have no IDs.';
comment on column app.file_assets.id is
  'Stable R2 blob identifier; it is not a unit document identifier.';

commit;

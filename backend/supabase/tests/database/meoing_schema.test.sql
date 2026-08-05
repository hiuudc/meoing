begin;

set local search_path = public, extensions, app, private;

-- pgTAP is installed in the extensions schema. These grants exist only inside
-- this test transaction and let assertions continue to run after SET ROLE.
-- Supabase Postgres 17 currently crashes when a CREATEROLE user adds a second
-- membership edge to a role it created. Use a transaction-scoped intermediary
-- so every explicit membership grant is new and the application roles stay
-- unchanged. See supabase/postgres#2325.
set local createrole_self_grant = 'set';
create role meoing_pgtap_executor
  nologin
  nosuperuser
  noinherit
  nocreatedb
  nocreaterole
  noreplication
  nobypassrls;
grant meoing_runtime to meoing_pgtap_executor
  with admin false, inherit false, set true;
grant usage on schema extensions to meoing_runtime;
grant execute on all functions in schema extensions to meoing_runtime;

select plan(150);

select ok(
  case
    when to_regprocedure('public.rls_auto_enable()') is null then true
    else not has_function_privilege(
      'anon',
      to_regprocedure('public.rls_auto_enable()'),
      'execute'
    )
  end,
  'anon cannot execute the Supabase RLS event-trigger helper'
);

select ok(
  case
    when to_regprocedure('public.rls_auto_enable()') is null then true
    else not has_function_privilege(
      'authenticated',
      to_regprocedure('public.rls_auto_enable()'),
      'execute'
    )
  end,
  'authenticated cannot execute the Supabase RLS event-trigger helper'
);

select is(
  (
    select array_agg(policy.cmd order by policy.cmd)
    from pg_policies as policy
    where policy.schemaname = 'app'
      and policy.tablename = 'collection_user_language_stats'
      and policy.roles @> array['meoing_runtime']::name[]
  ),
  array['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[],
  'collection language stats have one permissive policy per command'
);

create table public.meoing_default_acl_probe (
  id bigint primary key
);
create sequence public.meoing_default_acl_probe_sequence;

select ok(
  not exists (
    select 1
    from (
      values ('anon'), ('authenticated'), ('service_role')
    ) as role_name(value)
    cross join (
      values
        ('SELECT'),
        ('INSERT'),
        ('UPDATE'),
        ('DELETE'),
        ('TRUNCATE'),
        ('REFERENCES'),
        ('TRIGGER'),
        ('MAINTAIN')
    ) as privilege_name(value)
    where has_table_privilege(
      role_name.value,
      'public.meoing_default_acl_probe',
      privilege_name.value
    )

    union all

    select 1
    from (
      values ('anon'), ('authenticated'), ('service_role')
    ) as role_name(value)
    cross join (
      values ('USAGE'), ('SELECT'), ('UPDATE')
    ) as privilege_name(value)
    where has_sequence_privilege(
      role_name.value,
      'public.meoing_default_acl_probe_sequence',
      privilege_name.value
    )
  ),
  'future postgres-created public tables and sequences are fail-closed'
);

select has_index(
  'app',
  'collection_invite_roles',
  'collection_invite_roles_invite_collection_idx',
  'the composite invite foreign key has a covering index'
);

select has_table(
  'private',
  'deployment_identity',
  'the database has a private deployment-identity marker'
);

select ok(
  to_regprocedure('private.assert_database_identity(text,text)') is not null,
  'the database identity assertion function exists'
);

select ok(
  not has_table_privilege(
    'meoing_runtime',
    'private.deployment_identity',
    'select'
  ),
  'the runtime role cannot read the identity marker directly'
);

select ok(
  has_function_privilege(
    'meoing_runtime',
    'private.assert_database_identity(text,text)',
    'execute'
  ),
  'the runtime role can execute only the identity assertion function'
);

select ok(
  has_function_privilege(
    'meoing_maintenance',
    'private.assert_database_identity(text,text)',
    'execute'
  ),
  'the maintenance role can assert the database identity before cleanup'
);

select ok(
  not has_function_privilege(
    'anon',
    'private.assert_database_identity(text,text)',
    'execute'
  ),
  'anon cannot execute the database identity assertion'
);

select is(
  private.assert_database_identity(
    (select environment from private.deployment_identity where singleton),
    (select supabase_project_ref from private.deployment_identity where singleton)
  ) ->> 'environment',
  (select environment from private.deployment_identity where singleton),
  'the configured database marker reports its environment'
);

select is(
  private.assert_database_identity(
    (select environment from private.deployment_identity where singleton),
    (select supabase_project_ref from private.deployment_identity where singleton)
  ) ->> 'supabaseProjectRef',
  (select supabase_project_ref from private.deployment_identity where singleton),
  'the configured database marker reports its project identity'
);

select throws_ok(
  $$select private.assert_database_identity('production', 'aaaaaaaaaaaaaaaaaaaa')$$,
  '57P03',
  'DATABASE_IDENTITY_MISMATCH',
  'a Worker targeting a different environment fails closed'
);

create temporary table test_saved_deployment_identity
on commit drop
as
select *
from private.deployment_identity;

delete from private.deployment_identity;

create temporary table test_deployment_identity_results (
  attempt text not null,
  identity jsonb not null
) on commit drop;

with configured as (
  insert into private.deployment_identity as identity (
    singleton,
    environment,
    supabase_project_ref
  )
  values (true, 'staging', 'aaaaaaaaaaaaaaaaaaaa')
  on conflict (singleton) do update
  set configured_at = identity.configured_at
  where identity.environment = excluded.environment
    and identity.supabase_project_ref = excluded.supabase_project_ref
  returning jsonb_build_object(
    'environment', environment,
    'supabaseProjectRef', supabase_project_ref
  ) as identity
)
insert into test_deployment_identity_results (attempt, identity)
select 'fresh', identity
from configured;

select is(
  (
    select count(*)
    from test_deployment_identity_results
    where attempt = 'fresh'
  ),
  1::bigint,
  'a fresh hosted database accepts its first deployment marker'
);

select is(
  private.assert_database_identity(
    'staging',
    'aaaaaaaaaaaaaaaaaaaa'
  ) ->> 'supabaseProjectRef',
  'aaaaaaaaaaaaaaaaaaaa',
  'a separate post-commit-style statement sees the fresh deployment marker'
);

with configured as (
  insert into private.deployment_identity as identity (
    singleton,
    environment,
    supabase_project_ref
  )
  values (true, 'staging', 'aaaaaaaaaaaaaaaaaaaa')
  on conflict (singleton) do update
  set configured_at = identity.configured_at
  where identity.environment = excluded.environment
    and identity.supabase_project_ref = excluded.supabase_project_ref
  returning jsonb_build_object(
    'environment', environment,
    'supabaseProjectRef', supabase_project_ref
  ) as identity
)
insert into test_deployment_identity_results (attempt, identity)
select 'same', identity
from configured;

select is(
  (
    select count(*)
    from test_deployment_identity_results
    where attempt = 'same'
  ),
  1::bigint,
  'reconfiguring the same deployment marker is idempotent'
);

with configured as (
  insert into private.deployment_identity as identity (
    singleton,
    environment,
    supabase_project_ref
  )
  values (true, 'production', 'bbbbbbbbbbbbbbbbbbbb')
  on conflict (singleton) do update
  set configured_at = identity.configured_at
  where identity.environment = excluded.environment
    and identity.supabase_project_ref = excluded.supabase_project_ref
  returning jsonb_build_object(
    'environment', environment,
    'supabaseProjectRef', supabase_project_ref
  ) as identity
)
insert into test_deployment_identity_results (attempt, identity)
select 'conflict', identity
from configured;

select is(
  (
    select count(*)
    from test_deployment_identity_results
    where attempt = 'conflict'
  ),
  0::bigint,
  'a conflicting deployment marker returns no row'
);

select is(
  (
    select environment || '/' || supabase_project_ref
    from private.deployment_identity
    where singleton
  ),
  'staging/aaaaaaaaaaaaaaaaaaaa',
  'a conflicting deployment marker cannot replace the existing identity'
);

select throws_ok(
  $$select private.assert_database_identity('production', 'bbbbbbbbbbbbbbbbbbbb')$$,
  '57P03',
  'DATABASE_IDENTITY_MISMATCH',
  'the post-configuration assertion rejects a different deployment identity'
);

delete from private.deployment_identity;
insert into private.deployment_identity (
  singleton,
  environment,
  supabase_project_ref,
  configured_at
)
select
  singleton,
  environment,
  supabase_project_ref,
  configured_at
from test_saved_deployment_identity;

insert into app.username_reservations (
  username,
  reservation_type,
  reason
)
values ('admin', 'permanent', 'pgTAP fixture')
on conflict (username) do nothing;

select is(
  (
    select array_agg(username order by username)
    from app.username_reservations
    where reservation_type = 'permanent'
  ),
  array[
    'admin',
    'administrator',
    'api',
    'everyone',
    'help',
    'meoi',
    'meoing',
    'moderator',
    'null',
    'official',
    'root',
    'security',
    'staff',
    'support',
    'system',
    'undefined',
    'www'
  ]::text[],
  'hosted migrations install the complete permanent username reservation policy'
);

insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '10000000-0000-0000-0000-000000000001',
    'authenticated',
    'authenticated',
    'owner@example.test',
    '',
    now(),
    '{}',
    '{"full_name":"Owner"}',
    now(),
    now()
  ),
  (
    '10000000-0000-0000-0000-000000000002',
    'authenticated',
    'authenticated',
    'member@example.test',
    '',
    now(),
    '{}',
    '{"full_name":"Member"}',
    now(),
    now()
  ),
  (
    '10000000-0000-0000-0000-000000000003',
    'authenticated',
    'authenticated',
    'outsider@example.test',
    '',
    now(),
    '{}',
    '{"full_name":"Outsider"}',
    now(),
    now()
  );

select is(
  (
    select count(*)::integer
    from app.profiles
    where user_id in (
      '10000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000003'
    )
  ),
  3,
  'auth trigger creates one application profile per fixture user'
);

select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000001',
  true
);

select throws_ok(
  $$select private.api_change_username('{"username":"ab"}'::jsonb)$$,
  '22023',
  'INVALID_USERNAME',
  'username must contain at least three characters'
);

select lives_ok(
  $$select private.api_change_username('{"username":"owner.one"}'::jsonb)$$,
  'a valid Discord-style username is accepted'
);

select throws_ok(
  $$select private.api_change_username('{"username":"admin"}'::jsonb)$$,
  '23505',
  'USERNAME_UNAVAILABLE',
  'permanently reserved usernames cannot be claimed'
);

select lives_ok(
  $$select private.api_change_username('{"username":"owner.two"}'::jsonb)$$,
  'the first rename after onboarding is allowed'
);

select throws_ok(
  $$select private.api_change_username('{"username":"owner.three"}'::jsonb)$$,
  'P0001',
  'USERNAME_CHANGE_COOLDOWN',
  'subsequent username changes are rate-limited for seven days'
);

select private.api_abuse_consume(
  jsonb_build_object(
    'scope', 'username_lookup',
    'abuseKey', repeat('91', 32)
  )
);

select is(
  (
    private.api_username_availability(
      '{"username":"available.one"}'::jsonb
    ) ->> 'available'
  )::boolean,
  true,
  'username lookup works after its separately committed quota preflight'
);

create temporary table test_ids (
  key text primary key,
  value uuid not null
) on commit drop;

insert into test_ids (key, value)
select
  'collection_one',
  (private.api_collection_create('{"name":"Collection One"}'::jsonb) ->> 'id')::uuid;

select is(
  (
    select count(*)::integer
    from app.collection_roles
    where collection_id = (select value from test_ids where key = 'collection_one')
      and is_managed
      and name = '@everyone'
  ),
  1,
  'collection creation seeds exactly one managed everyone role'
);

insert into test_ids (key, value)
select
  'teacher_role',
  (
    private.api_role_create(
      jsonb_build_object(
        'collectionId', (select value from test_ids where key = 'collection_one'),
        'name', 'Teacher',
        'permissions', jsonb_build_array(
          'create_content',
          'edit_content',
          'create_lessons'
        ),
        'securityRank', 10
      )
    ) ->> 'id'
  )::uuid;

select lives_ok(
  format(
    $$select private.api_invite_create(
      jsonb_build_object(
        'collectionId', %L,
        'tokenHash', encode(digest('invite-one', 'sha256'), 'hex'),
        'tokenHint', 'abcd',
        'maxUses', 1,
        'roleIds', jsonb_build_array(%L)
      )
    )$$,
    (select value from test_ids where key = 'collection_one'),
    (select value from test_ids where key = 'teacher_role')
  ),
  'an owner can create a reusable hashed invite with roles'
);

select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000002',
  true
);
select private.api_change_username('{"username":"member.one"}'::jsonb);
select private.api_abuse_consume(
  jsonb_build_object(
    'scope', 'invite_accept',
    'abuseKey', repeat('a1', 32)
  )
);

select lives_ok(
  $$select private.api_invite_accept(
    jsonb_build_object(
      'tokenHash',
      encode(digest('invite-one', 'sha256'), 'hex'),
      'idempotencyKey',
      'member-accept-key-0001'
    )
  )$$,
  'the first invite redemption succeeds'
);

select is(
  (
    select count(*)::integer
    from app.collection_member_roles
    where collection_id = (select value from test_ids where key = 'collection_one')
      and user_id = '10000000-0000-0000-0000-000000000002'
      and role_id = (select value from test_ids where key = 'teacher_role')
  ),
  1,
  'invite redemption assigns every configured role'
);

select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000001',
  true
);

select throws_ok(
  format(
    $$select private.api_collection_profile_upsert(
      jsonb_build_object(
        'collectionId', %L,
        'userId', '10000000-0000-0000-0000-000000000002',
        'displayName', 'Missing revision'
      )
    )$$,
    (select value from test_ids where key = 'collection_one')
  ),
  '22023',
  'EXPECTED_REVISION_REQUIRED',
  'collection profile writes require an explicit optimistic revision'
);

select throws_ok(
  format(
    $$select private.api_collection_profile_upsert(
      jsonb_build_object(
        'collectionId', %L,
        'userId', '10000000-0000-0000-0000-000000000002',
        'displayName', 'Wrong create revision',
        'expectedRevision', 1
      )
    )$$,
    (select value from test_ids where key = 'collection_one')
  ),
  '40001',
  'REVISION_CONFLICT',
  'a new collection profile must be created from revision zero'
);

select lives_ok(
  format(
    $$select private.api_collection_profile_upsert(
      jsonb_build_object(
        'collectionId', %L,
        'userId', '10000000-0000-0000-0000-000000000002',
        'displayName', 'Classroom name',
        'expectedRevision', 0
      )
    )$$,
    (select value from test_ids where key = 'collection_one')
  ),
  'an authorized owner can create a member collection profile from revision zero'
);

select is(
  (
    select item ->> 'profileRevision'
    from jsonb_array_elements(
      private.api_collection_member_list(
        jsonb_build_object(
          'collectionId',
          (select value from test_ids where key = 'collection_one')
        )
      ) -> 'items'
    ) as item
    where item ->> 'userId' = '10000000-0000-0000-0000-000000000002'
  ),
  '1',
  'member lists expose the collection profile optimistic revision'
);

select is(
  (
    select item #>> '{collectionProfile,displayName}'
    from jsonb_array_elements(
      private.api_collection_member_list(
        jsonb_build_object(
          'collectionId',
          (select value from test_ids where key = 'collection_one')
        )
      ) -> 'items'
    ) as item
    where item ->> 'userId' = '10000000-0000-0000-0000-000000000002'
  ),
  'Classroom name',
  'member lists keep raw collection-profile overrides separate from effective fields'
);

select lives_ok(
  format(
    $$select private.api_collection_profile_upsert(
      jsonb_build_object(
        'collectionId', %L,
        'userId', '10000000-0000-0000-0000-000000000002',
        'bio', 'Revision two',
        'expectedRevision', 1
      )
    )$$,
    (select value from test_ids where key = 'collection_one')
  ),
  'an existing collection profile accepts its exact current revision'
);

select throws_ok(
  format(
    $$select private.api_collection_profile_upsert(
      jsonb_build_object(
        'collectionId', %L,
        'userId', '10000000-0000-0000-0000-000000000002',
        'bio', 'Stale writer',
        'expectedRevision', 1
      )
    )$$,
    (select value from test_ids where key = 'collection_one')
  ),
  '40001',
  'REVISION_CONFLICT',
  'a stale collection profile revision is rejected'
);

select throws_ok(
  format(
    $$select private.api_collection_profile_upsert(
      jsonb_build_object(
        'collectionId', %L,
        'userId', '10000000-0000-0000-0000-000000000003',
        'displayName', 'Not a member',
        'expectedRevision', 0
      )
    )$$,
    (select value from test_ids where key = 'collection_one')
  ),
  '42501',
  'COLLECTION_PROFILE_FORBIDDEN',
  'a collection profile cannot be created for a non-member'
);

insert into test_ids (key, value)
select
  'role_manager',
  (
    private.api_role_create(
      jsonb_build_object(
        'collectionId', (select value from test_ids where key = 'collection_one'),
        'name', 'Role manager',
        'permissions', jsonb_build_array('manage_roles'),
        'securityRank', 20
      )
    ) ->> 'id'
  )::uuid;

select private.api_role_assign(
  jsonb_build_object(
    'collectionId', (select value from test_ids where key = 'collection_one'),
    'roleId', (select value from test_ids where key = 'role_manager'),
    'userId', '10000000-0000-0000-0000-000000000002'
  )
);

select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000002',
  true
);

select throws_ok(
  format(
    $$select private.api_role_update(
      jsonb_build_object(
        'collectionId', %L,
        'roleId', %L,
        'permissions', jsonb_build_array('create_content', 'manage_collection'),
        'expectedRevision', 1
      )
    )$$,
    (select value from test_ids where key = 'collection_one'),
    (select value from test_ids where key = 'teacher_role')
  ),
  '42501',
  'ROLE_PERMISSION_ESCALATION',
  'a role manager cannot grant permissions they do not already possess'
);

select throws_ok(
  format(
    $$select private.api_role_update(
      jsonb_build_object(
        'collectionId', %L,
        'roleId', (
          select id
          from app.collection_roles
          where collection_id = %L
            and is_managed
        ),
        'permissions', jsonb_build_array('manage_collection'),
        'expectedRevision', 1
      )
    )$$,
    (select value from test_ids where key = 'collection_one'),
    (select value from test_ids where key = 'collection_one')
  ),
  '42501',
  'MANAGED_ROLE_OWNER_REQUIRED',
  'only the collection owner can change everyone permissions'
);

select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000003',
  true
);
select private.api_change_username('{"username":"outsider.one"}'::jsonb);
select private.api_abuse_consume(
  jsonb_build_object(
    'scope', 'invite_accept',
    'abuseKey', repeat('b2', 32)
  )
);

select throws_ok(
  $$select private.api_invite_accept(
    jsonb_build_object(
      'tokenHash',
      encode(digest('invite-one', 'sha256'), 'hex'),
      'idempotencyKey',
      'outsider-accept-key-01'
    )
  )$$,
  'P0001',
  'INVITE_INVALID',
  'row locking and max-use checks reject an exhausted invite'
);

insert into test_ids (key, value)
select
  'collection_two',
  (private.api_collection_create('{"name":"Collection Two"}'::jsonb) ->> 'id')::uuid;

set local role meoing_runtime;
select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000002',
  true
);

select is(
  (select count(*)::integer from app.collections),
  1,
  'RLS only exposes collections shared with the current user'
);

select is(
  (
    select count(*)::integer
    from app.profiles
    where user_id = '10000000-0000-0000-0000-000000000003'
  ),
  0,
  'main profiles are hidden when users do not share a collection'
);

select throws_ok(
  $$delete from app.collection_audit_logs$$,
  '42501',
  null,
  'runtime role cannot mutate append-only audit logs'
);

reset role;
select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000001',
  true
);

insert into app.file_assets (
  id,
  collection_id,
  owner_id,
  r2_key,
  original_filename,
  mime_type,
  expected_size_bytes,
  expected_sha256,
  size_bytes,
  sha256,
  etag,
  uploaded_at,
  status,
  ready_at
)
values
  (
    '50000000-0000-4000-8000-000000000001',
    (select value from test_ids where key = 'collection_one'),
    '10000000-0000-0000-0000-000000000001',
    'test/collection-one/asset-one',
    'one.png',
    'image/png',
    8,
    decode(repeat('ab', 32), 'hex'),
    8,
    decode(repeat('ab', 32), 'hex'),
    'etag-one',
    now(),
    'ready',
    now()
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    (select value from test_ids where key = 'collection_two'),
    '10000000-0000-0000-0000-000000000003',
    'test/collection-two/asset-two',
    'two.png',
    'image/png',
    8,
    decode(repeat('cd', 32), 'hex'),
    8,
    decode(repeat('cd', 32), 'hex'),
    'etag-two',
    now(),
    'ready',
    now()
  );

select is(
  private.api_file_get(
    jsonb_build_object(
      'assetId', '50000000-0000-4000-8000-000000000001',
      'purpose', 'finalize'
    )
  ) ->> 'status',
  'ready',
  'a finalize retry can look up an already-ready asset owned by the caller'
);

select throws_ok(
  $$select private.api_file_get(
    '{"assetId":"50000000-0000-4000-8000-000000000002","purpose":"download"}'::jsonb
  )$$,
  '42501',
  'FILE_FORBIDDEN',
  'a user cannot authorize download of an asset from another collection'
);

select ok(
  private.unit_documents_have_safe_images(
    '[{"title":"External","content":{"root":{"children":[{"type":"meoi-image","src":"https://images.example.test/pixel.png"}]}}}]'::jsonb
  ),
  'unit documents allow a persisted external HTTPS image without an asset ID'
);

select throws_ok(
  format(
    $query$select private.api_unit_create(
      jsonb_build_object(
        'collectionId', %L,
        'name', 'Asset image with transient URL',
        'languageCode', 'en',
        'words', '[]'::jsonb,
        'phrases', '[]'::jsonb,
        'sentences', '[]'::jsonb,
        'documents', '[{"title":"Unsafe","content":{"root":{"children":[{"type":"meoi-image","assetId":"50000000-0000-4000-8000-000000000001","src":"https://signed.example/temporary.png"}]}}}]'::jsonb
      )
    )$query$,
    (select value from test_ids where key = 'collection_one')
  ),
  '23514',
  null,
  'unit creation rejects transient image URLs even when an asset ID is present'
);

select is(
  private.sanitize_unit_documents_images(
    '[{"title":"Legacy","content":{"root":{"children":[{"type":"meoi-image","assetId":"50000000-0000-4000-8000-000000000001","src":"https://tracker.example/pixel.png","altText":"kept"}]}}}]'::jsonb,
    (select value from test_ids where key = 'collection_one')
  ),
  '[{"title":"Legacy","content":{"root":{"children":[{"type":"meoi-image","assetId":"50000000-0000-4000-8000-000000000001","altText":"kept"}]}}}]'::jsonb,
  'legacy cleanup strips src while retaining an authorized asset-backed image'
);

select is(
  private.sanitize_unit_documents_images(
    '[{"title":"External","content":{"root":{"children":[{"type":"meoi-image","src":"https://images.example.test/pixel.png","altText":"kept"}]}}}]'::jsonb,
    (select value from test_ids where key = 'collection_one')
  ),
  '[{"title":"External","content":{"root":{"children":[{"type":"meoi-image","src":"https://images.example.test/pixel.png","altText":"kept"}]}}}]'::jsonb,
  'image sanitizer preserves an external HTTPS image'
);

select ok(
  not has_function_privilege(
    'meoing_runtime',
    to_regprocedure('private.sanitize_unit_documents_images(jsonb,uuid)'),
    'execute'
  ),
  'runtime callers cannot invoke the privileged legacy image sanitizer directly'
);

insert into test_ids (key, value)
select
  'unit_one',
  (
    private.api_unit_create(
      jsonb_build_object(
        'collectionId', (select value from test_ids where key = 'collection_one'),
        'name', 'Basics',
        'description', 'Core movement verbs',
        'instructionOverride', 'Prefer short, practical prompts.',
        'languageCode', 'en',
        'words', '[{"text":"go","translation":"đi","notes":"verb"},"went"]'::jsonb,
        'phrases', '["go home"]'::jsonb,
        'sentences', '["I went home."]'::jsonb,
        'documents', '[{"title":"Notes","content":{"root":{"children":[{"type":"meoi-image","assetId":"50000000-0000-4000-8000-000000000001","src":""}]}}}]'::jsonb
      )
    ) ->> 'id'
  )::uuid;

select is(
  (
    private.api_unit_list(
      jsonb_build_object(
        'collectionId',
        (select value from test_ids where key = 'collection_one'),
        'limit',
        1
      )
    ) #> '{items,0}'
  ) ? 'words',
  false,
  'unit list responses do not materialize full content JSON'
);

select is(
  (
    select words -> 0 ->> 'translation'
    from app.units
    where id = (select value from test_ids where key = 'unit_one')
  ),
  'đi',
  'unit term objects preserve metadata while using text as their surface'
);

select is(
  (
    select description
    from app.units
    where id = (select value from test_ids where key = 'unit_one')
  ),
  'Core movement verbs',
  'unit description is stored alongside content'
);

select is(
  (
    select snapshot ->> 'instructionOverride'
    from app.unit_revisions
    where unit_id = (select value from test_ids where key = 'unit_one')
      and revision = 1
  ),
  'Prefer short, practical prompts.',
  'unit revisions retain the lesson instruction override'
);

select is(
  (
    select reference_count
    from app.file_assets
    where id = '50000000-0000-4000-8000-000000000001'
  ),
  2,
  'the current unit and its retained revision both hold asset references'
);

select throws_ok(
  format(
    $$insert into app.units (
      collection_id, created_by, name, language_code, words
    ) values (%L, %L, 'Invalid', 'en', '["go",{"text":"go"}]')$$,
    (select value from test_ids where key = 'collection_one'),
    '10000000-0000-0000-0000-000000000001'
  ),
  '23514',
  null,
  'unit JSON arrays reject duplicate normalized surface strings'
);

select throws_ok(
  format(
    $$insert into app.units (
      collection_id, created_by, name, language_code, words
    ) values (%L, %L, 'Invalid ID', 'en', '[{"id":"term-1","text":"go"}]')$$,
    (select value from test_ids where key = 'collection_one'),
    '10000000-0000-0000-0000-000000000001'
  ),
  '23514',
  null,
  'unit term objects reject per-item IDs'
);

select throws_ok(
  format(
    $$select private.api_unit_update(
      jsonb_build_object(
        'unitId', %L,
        'expectedRevision', 1,
        'name', 'Cross collection attempt',
        'languageCode', 'en',
        'words', '[{"text":"go","translation":"đi","notes":"verb"},"went"]'::jsonb,
        'phrases', '["go home"]'::jsonb,
        'sentences', '["I went home."]'::jsonb,
        'documents', '[{"title":"Invalid","content":{"root":{"children":[{"assetId":"50000000-0000-4000-8000-000000000002"}]}}}]'::jsonb
      )
    )$$,
    (select value from test_ids where key = 'unit_one')
  ),
  '42501',
  'ASSET_REFERENCE_FORBIDDEN',
  'a unit cannot attach an asset from another collection'
);

select throws_ok(
  format(
    $$select private.api_unit_update(
      jsonb_build_object(
        'unitId', %L,
        'expectedRevision', 1,
        'name', 'External source attempt',
        'languageCode', 'en',
        'words', '[{"text":"go","translation":"Ä‘i","notes":"verb"},"went"]'::jsonb,
        'phrases', '["go home"]'::jsonb,
        'sentences', '["I went home."]'::jsonb,
        'documents', '[{"title":"Unsafe","content":{"root":{"children":[{"type":"meoi-image","assetId":"50000000-0000-4000-8000-000000000001","src":"https://tracker.example/pixel.png"}]}}}]'::jsonb
      )
    )$$,
    (select value from test_ids where key = 'unit_one')
  ),
  '23514',
  null,
  'unit updates reject persisted image source URLs'
);

select is(
  (
    select revision
    from app.units
    where id = (select value from test_ids where key = 'unit_one')
  ),
  1::bigint,
  'a rejected external image update leaves the unit revision unchanged'
);

select throws_ok(
  $$select private.api_file_delete(
    '{"assetId":"50000000-0000-4000-8000-000000000001"}'::jsonb
  )$$,
  '23503',
  'FILE_IS_REFERENCED',
  'a referenced collection asset cannot be deleted'
);

select lives_ok(
  format(
    $$select private.api_unit_update(
      jsonb_build_object(
        'unitId', %L,
        'expectedRevision', 1,
        'name', 'Basics updated',
        'description', 'Updated movement verbs',
        'languageCode', 'en',
        'words', '[{"text":"go","translation":"đi","notes":"verb"},"went"]'::jsonb,
        'phrases', '["go home"]'::jsonb,
        'sentences', '["I went home."]'::jsonb,
        'documents', '[{"title":"Notes","content":{"root":{"children":[{"type":"meoi-image","assetId":"50000000-0000-4000-8000-000000000001"}]}}}]'::jsonb
      )
    )$$,
    (select value from test_ids where key = 'unit_one')
  ),
  'a unit update stores a complete new revision'
);

select is(
  (
    select instruction_override
    from app.units
    where id = (select value from test_ids where key = 'unit_one')
  ),
  'Prefer short, practical prompts.',
  'omitting instructionOverride on update preserves its existing value'
);

select is(
  (
    select count(*)::integer
    from app.unit_revisions
    where unit_id = (select value from test_ids where key = 'unit_one')
  ),
  2,
  'unit revisions retain full snapshots for create and update'
);

select is(
  (
    private.api_unit_revision_list(
      jsonb_build_object(
        'unitId',
        (select value from test_ids where key = 'unit_one'),
        'limit',
        1
      )
    ) #> '{items,0}'
  ) ? 'snapshot',
  false,
  'unit revision lists omit full snapshots'
);

select lives_ok(
  format(
    $$select private.api_unit_revision_restore(
      jsonb_build_object(
        'unitId', %L,
        'revision', 1,
        'expectedRevision', 2
      )
    )$$,
    (select value from test_ids where key = 'unit_one')
  ),
  'an owner can restore a retained unit revision from the current revision'
);

select is(
  (
    select jsonb_build_object(
      'name', name,
      'firstWord', words -> 0 ->> 'text',
      'revision', revision
    )
    from app.units
    where id = (select value from test_ids where key = 'unit_one')
  ),
  '{"name":"Basics","firstWord":"go","revision":3}'::jsonb,
  'unit revision restore reapplies content and name as a new revision'
);

select throws_ok(
  format(
    $$select private.api_unit_revision_restore(
      jsonb_build_object(
        'unitId', %L,
        'revision', 1,
        'expectedRevision', 2
      )
    )$$,
    (select value from test_ids where key = 'unit_one')
  ),
  '40001',
  'REVISION_CONFLICT',
  'a stale unit revision restore is rejected'
);

insert into test_ids (key, value)
select
  'unit_legacy_image',
  (
    private.api_unit_create(
      jsonb_build_object(
        'collectionId', (select value from test_ids where key = 'collection_one'),
        'name', 'Legacy image restore',
        'languageCode', 'en',
        'words', '[]'::jsonb,
        'phrases', '[]'::jsonb,
        'sentences', '[]'::jsonb,
        'documents', '[{"title":"Legacy","content":{"root":{"children":[]}}}]'::jsonb
      )
    ) ->> 'id'
  )::uuid;

-- Simulate a pre-invariant snapshot. NOT VALID keeps the historical row in
-- place while still checking the new restored revision written by the RPC.
alter table app.unit_revisions
  drop constraint unit_revisions_persisted_images_are_asset_backed;

update app.unit_revisions
set snapshot = jsonb_set(
  snapshot,
  '{documents}',
  '[{"title":"Legacy","content":{"root":{"children":[{"type":"meoi-image","src":"https://tracker.example/pixel.png"}]}}}]'::jsonb,
  true
)
where unit_id = (select value from test_ids where key = 'unit_legacy_image')
  and revision = 1;

alter table app.unit_revisions
  add constraint unit_revisions_persisted_images_are_asset_backed
  check (
    private.unit_documents_have_safe_images(
      coalesce(snapshot -> 'documents', '[]'::jsonb)
    )
  )
  not valid;

select lives_ok(
  format(
    $$select private.api_unit_revision_restore(
      jsonb_build_object(
        'unitId', %L,
        'revision', 1,
        'expectedRevision', 1
      )
    )$$,
    (select value from test_ids where key = 'unit_legacy_image')
  ),
  'restoring a snapshot preserves an external HTTPS image'
);

select is(
  (
    select documents
    from app.units
    where id = (select value from test_ids where key = 'unit_legacy_image')
  ),
  '[{"title":"Legacy","content":{"root":{"children":[{"type":"meoi-image","src":"https://tracker.example/pixel.png"}]}}}]'::jsonb,
  'restore keeps a valid external HTTPS image'
);

delete from app.units
where id = (select value from test_ids where key = 'unit_legacy_image');
select set_config('app.maintenance_cleanup', 'on', true);
delete from app.collection_audit_logs
where target_type = 'units'
  and target_id = (select value from test_ids where key = 'unit_legacy_image');
select set_config('app.maintenance_cleanup', 'off', true);
delete from test_ids where key = 'unit_legacy_image';

alter table app.unit_revisions
  validate constraint unit_revisions_persisted_images_are_asset_backed;

select throws_ok(
  format(
    $$select private.api_lesson_create(
      jsonb_build_object(
        'collectionId', %L,
        'unitId', %L,
        'unitRevision', 2,
        'title', 'Wrong language',
        'languageCode', 'fr',
        'payload', jsonb_build_object(
          'schemaVersion', 8,
          'questions', jsonb_build_array(
            jsonb_build_object(
              'questionId', 'q-language',
              'tracking', jsonb_build_object(
                'encountered', jsonb_build_object(
                  'words', jsonb_build_array('go'),
                  'phrases', '[]'::jsonb,
                  'sentences', '[]'::jsonb
                ),
                'assessed', jsonb_build_object(
                  'words', jsonb_build_array('go'),
                  'phrases', '[]'::jsonb,
                  'sentences', '[]'::jsonb
                )
              )
            )
          )
        )
      )
    )$$,
    (select value from test_ids where key = 'collection_one'),
    (select value from test_ids where key = 'unit_one')
  ),
  '22023',
  'LESSON_LANGUAGE_MISMATCH',
  'lesson language must match its source unit revision'
);

select throws_ok(
  format(
    $$select private.api_unit_update(
      jsonb_build_object(
        'unitId', %L,
        'expectedRevision', 1,
        'words', '[{"text":"go","translation":"đi","notes":"verb"},"went"]'::jsonb,
        'phrases', '["go home"]'::jsonb,
        'sentences', '["I went home."]'::jsonb,
        'documents', '[{"title":"Notes","content":{"root":{"children":[{"type":"meoi-image","assetId":"50000000-0000-4000-8000-000000000001"}]}}}]'::jsonb
      )
    )$$,
    (select value from test_ids where key = 'unit_one')
  ),
  '40001',
  'REVISION_CONFLICT',
  'stale unit writers receive an optimistic concurrency conflict'
);

insert into test_ids (key, value)
select
  'lesson_one',
  (
    private.api_lesson_create(
      jsonb_build_object(
        'collectionId', (select value from test_ids where key = 'collection_one'),
        'unitId', (select value from test_ids where key = 'unit_one'),
        'unitRevision', 2,
        'title', 'Go practice',
        'languageCode', 'en',
        'payload', jsonb_build_object(
          'schemaVersion', 8,
          'questions',
          jsonb_build_array(
            jsonb_build_object(
              'questionId', 'q1',
              'tracking', jsonb_build_object(
                'encountered', jsonb_build_object(
                  'words', jsonb_build_array('go'),
                  'phrases', '[]'::jsonb,
                  'sentences', '[]'::jsonb
                ),
                'assessed', jsonb_build_object(
                  'words', jsonb_build_array('go'),
                  'phrases', '[]'::jsonb,
                  'sentences', '[]'::jsonb
                )
              )
            )
          )
        )
      )
    ) ->> 'id'
  )::uuid;

select is(
  (
    private.api_lesson_list(
      jsonb_build_object(
        'collectionId',
        (select value from test_ids where key = 'collection_one'),
        'limit',
        1
      )
    ) #> '{items,0}'
  ) ? 'payload',
  false,
  'lesson list responses do not materialize full payload JSON'
);

insert into test_ids (key, value)
select
  'progress_one',
  (
    private.api_progress_start(
      jsonb_build_object(
        'lessonId', (select value from test_ids where key = 'lesson_one'),
        'idempotencyKey', 'progress-start-key-001'
      )
    ) ->> 'id'
  )::uuid;

select is(
  (
    private.api_progress_start(
      jsonb_build_object(
        'lessonId', (select value from test_ids where key = 'lesson_one'),
        'idempotencyKey', 'progress-start-key-001'
      )
    ) ->> 'id'
  )::uuid,
  (select value from test_ids where key = 'progress_one'),
  'retrying progress start returns the original session'
);

select is(
  (
    select (aggregate ->> 'sessionCount')::integer
    from app.user_language_stats
    where user_id = '10000000-0000-0000-0000-000000000001'
      and language_code = 'en'
  ),
  1,
  'a retried progress start increments sessionCount only once'
);

select lives_ok(
  format(
    $$select private.api_progress_submit_batch(
      jsonb_build_object(
        'batchId', '20000000-0000-0000-0000-000000000001',
        'progressId', %L,
        'completedAt', '2000-01-01T00:00:00Z',
        'events', jsonb_build_array(
          jsonb_build_object(
            'eventId', '30000000-0000-0000-0000-000000000001',
            'attemptId', '40000000-0000-0000-0000-000000000001',
            'questionId', 'q1',
            'attemptNumber', 1,
            'answer', 'go',
            'status', 'correct',
            'score', 1,
            'answeredAt', '2000-01-01T00:00:00Z',
            'evaluationSource', 'client_extension'
          )
        )
      )
    )$$,
    (select value from test_ids where key = 'progress_one')
  ),
  'a valid progress batch is accepted atomically'
);

select is(
  (
    select (words -> 'go' ->> 'encounterCount')::integer
    from app.user_language_stats
    where user_id = '10000000-0000-0000-0000-000000000001'
      and language_code = 'en'
  ),
  1,
  'a tracked term is encountered once per question per session'
);

select is(
  (
    select (words -> 'go' ->> 'encounterCount')::integer
    from app.collection_user_language_stats
    where collection_id = (select value from test_ids where key = 'collection_one')
      and user_id = '10000000-0000-0000-0000-000000000001'
      and language_code = 'en'
  ),
  1,
  'the same transaction updates collection term statistics'
);

select is(
  (
    select words -> 'go' ->> 'learnedAt'
    from app.user_language_stats
    where user_id = '10000000-0000-0000-0000-000000000001'
      and language_code = 'en'
  ) is not null,
  true,
  'the first correct assessed answer records learnedAt'
);

select isnt(
  (
    select attempts -> 0 ->> 'answeredAt'
    from app.lesson_progress
    where id = (select value from test_ids where key = 'progress_one')
  ),
  '2000-01-01T00:00:00+00:00',
  'canonical answer timestamps are assigned by PostgreSQL'
);

select is(
  (
    select attempts -> 0 ->> 'clientAnsweredAt'
    from app.lesson_progress
    where id = (select value from test_ids where key = 'progress_one')
  ),
  '2000-01-01T00:00:00+00:00',
  'the client event timestamp is retained only as non-canonical metadata'
);

select isnt(
  (
    select completed_at::text
    from app.lesson_progress
    where id = (select value from test_ids where key = 'progress_one')
  ),
  '2000-01-01 00:00:00+00',
  'canonical completion timestamps are assigned by PostgreSQL'
);

select is(
  (
    private.api_progress_history(
      jsonb_build_object(
        'userId', '10000000-0000-0000-0000-000000000001',
        'limit', 1
      )
    ) #> '{items,0}'
  ) ? 'attempts',
  false,
  'progress history does not materialize raw answers'
);

select is(
  (
    private.api_progress_get(
      jsonb_build_object(
        'progressId',
        (select value from test_ids where key = 'progress_one')
      )
    ) -> 'attempts'
  ) @> '[{"questionId":"q1"}]'::jsonb,
  true,
  'a bounded progress detail lookup returns the owner raw answers'
);

insert into test_ids (key, value)
select
  'progress_viewer_role',
  (
    private.api_role_create(
      jsonb_build_object(
        'collectionId', (select value from test_ids where key = 'collection_one'),
        'name', 'Progress viewer',
        'permissions', jsonb_build_array('view_member_progress'),
        'securityRank', 5
      )
    ) ->> 'id'
  )::uuid;

select private.api_role_assign(
  jsonb_build_object(
    'collectionId', (select value from test_ids where key = 'collection_one'),
    'roleId', (select value from test_ids where key = 'progress_viewer_role'),
    'userId', '10000000-0000-0000-0000-000000000002'
  )
);

select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000002',
  true
);

select throws_ok(
  format(
    $$select private.api_progress_get(
      jsonb_build_object('progressId', %L)
    )$$,
    (select value from test_ids where key = 'progress_one')
  ),
  '42501',
  'PROGRESS_ANSWERS_FORBIDDEN',
  'summary permission alone cannot read another member raw answers'
);

select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000001',
  true
);

select is(
  (
    private.api_progress_submit_batch(
      jsonb_build_object(
        'batchId', '20000000-0000-0000-0000-000000000001',
        'progressId', (select value from test_ids where key = 'progress_one'),
        'completedAt', '2000-01-01T00:00:00Z',
        'events', jsonb_build_array(
          jsonb_build_object(
            'eventId', '30000000-0000-0000-0000-000000000001',
            'attemptId', '40000000-0000-0000-0000-000000000001',
            'questionId', 'q1',
            'attemptNumber', 1,
            'answer', 'go',
            'status', 'correct',
            'score', 1,
            'answeredAt', '2000-01-01T00:00:00Z',
            'evaluationSource', 'client_extension'
          )
        )
      )
    ) ->> 'acceptedEvents'
  )::integer,
  1,
  'retrying the same batch returns the original exact-once result'
);

select throws_ok(
  format(
    $$select private.api_progress_submit_batch(
      jsonb_build_object(
        'batchId', '20000000-0000-0000-0000-000000000001',
        'progressId', %L,
        'completedAt', '2000-01-01T00:00:00Z',
        'events', jsonb_build_array(
          jsonb_build_object(
            'eventId', '30000000-0000-0000-0000-000000000001',
            'attemptId', '40000000-0000-0000-0000-000000000001',
            'questionId', 'q1',
            'attemptNumber', 1,
            'answer', 'different answer',
            'status', 'correct',
            'score', 1,
            'answeredAt', '2000-01-01T00:00:00Z',
            'evaluationSource', 'client_extension'
          )
        )
      )
    )$$,
    (select value from test_ids where key = 'progress_one')
  ),
  '23505',
  'IDEMPOTENCY_KEY_REUSED',
  'reusing a progress batch id with a different payload is rejected'
);

insert into test_ids (key, value)
select
  'lesson_private',
  (
    private.api_lesson_create(
      jsonb_build_object(
        'collectionId', (select value from test_ids where key = 'collection_one'),
        'unitId', (select value from test_ids where key = 'unit_one'),
        'unitRevision', 2,
        'title', 'Owner private draft',
        'languageCode', 'en',
        'payload', jsonb_build_object(
          'schemaVersion', 8,
          'questions',
          jsonb_build_array(
            jsonb_build_object(
              'questionId', 'q-private',
              'tracking', jsonb_build_object(
                'encountered', jsonb_build_object(
                  'words', jsonb_build_array('go'),
                  'phrases', '[]'::jsonb,
                  'sentences', '[]'::jsonb
                ),
                'assessed', jsonb_build_object(
                  'words', jsonb_build_array('go'),
                  'phrases', '[]'::jsonb,
                  'sentences', '[]'::jsonb
                )
              )
            )
          )
        )
      )
    ) ->> 'id'
  )::uuid;

select private.api_lesson_publish(
  jsonb_build_object(
    'lessonId', (select value from test_ids where key = 'lesson_one'),
    'expectedRevision', 1
  )
);

select private.api_character_progress_upsert(
  jsonb_build_object(
    'languageCode', 'en',
    'characters', '{"g":{"encounterCount":1}}'::jsonb,
    'expectedRevision', 0
  )
);

insert into app.settings (scope_type, user_id, collection_id, key, value)
values
  (
    'user',
    '10000000-0000-0000-0000-000000000001',
    null,
    'owner.private',
    '{"theme":"owner"}'
  ),
  (
    'collection',
    null,
    (select value from test_ids where key = 'collection_one'),
    'collection.shared',
    '{"locale":"en"}'
  ),
  (
    'collection_user',
    '10000000-0000-0000-0000-000000000001',
    (select value from test_ids where key = 'collection_one'),
    'owner.collection-user',
    '{"notifications":true}'
  );

insert into app.file_assets (
  id,
  owner_id,
  r2_key,
  original_filename,
  mime_type,
  expected_size_bytes,
  expected_sha256,
  size_bytes,
  sha256,
  etag,
  uploaded_at,
  status,
  ready_at
)
values (
  '50000000-0000-4000-8000-000000000003',
  '10000000-0000-0000-0000-000000000001',
  'test/private/owner-asset',
  'owner-private.txt',
  'text/plain',
  8,
  decode(repeat('ef', 32), 'hex'),
  8,
  decode(repeat('ef', 32), 'hex'),
  'etag-owner-private',
  now(),
  'ready',
  now()
);

select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000002',
  true
);

insert into test_ids (key, value)
select
  'progress_member',
  (
    private.api_progress_start(
      jsonb_build_object(
        'lessonId', (select value from test_ids where key = 'lesson_one'),
        'idempotencyKey', 'progress-start-member-001'
      )
    ) ->> 'id'
  )::uuid;

select private.api_progress_submit_batch(
  jsonb_build_object(
    'batchId', '20000000-0000-0000-0000-000000000002',
    'progressId', (select value from test_ids where key = 'progress_member'),
    'events', jsonb_build_array(
      jsonb_build_object(
        'eventId', '30000000-0000-0000-0000-000000000002',
        'attemptId', '40000000-0000-0000-0000-000000000002',
        'questionId', 'q1',
        'attemptNumber', 1,
        'answer', 'go',
        'status', 'correct',
        'score', 1,
        'answeredAt', '2000-01-02T00:00:00Z',
        'evaluationSource', 'client_extension'
      )
    )
  )
);

select private.api_character_progress_upsert(
  jsonb_build_object(
    'languageCode', 'en',
    'characters', '{"m":{"encounterCount":1}}'::jsonb,
    'expectedRevision', 0
  )
);

insert into app.settings (scope_type, user_id, collection_id, key, value)
values
  (
    'user',
    '10000000-0000-0000-0000-000000000002',
    null,
    'member.private',
    '{"theme":"member"}'
  ),
  (
    'collection_user',
    '10000000-0000-0000-0000-000000000002',
    (select value from test_ids where key = 'collection_one'),
    'member.collection-user',
    '{"notifications":false}'
  );

select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000003',
  true
);

insert into test_ids (key, value)
select
  'outsider_role',
  (
    private.api_role_create(
      jsonb_build_object(
        'collectionId', (select value from test_ids where key = 'collection_two'),
        'name', 'Outsider teacher',
        'permissions', jsonb_build_array('create_content', 'create_lessons'),
        'securityRank', 5
      )
    ) ->> 'id'
  )::uuid;

insert into test_ids (key, value)
select
  'invite_two',
  (
    private.api_invite_create(
      jsonb_build_object(
        'collectionId', (select value from test_ids where key = 'collection_two'),
        'tokenHash', encode(digest('invite-two', 'sha256'), 'hex'),
        'tokenHint', 'efgh',
        'maxUses', 2,
        'roleIds', jsonb_build_array(
          (select value from test_ids where key = 'outsider_role')
        )
      )
    ) ->> 'id'
  )::uuid;

insert into test_ids (key, value)
select
  'unit_two',
  (
    private.api_unit_create(
      jsonb_build_object(
        'collectionId', (select value from test_ids where key = 'collection_two'),
        'name', 'Outsider unit',
        'languageCode', 'en',
        'words', '["outside"]'::jsonb,
        'phrases', '[]'::jsonb,
        'sentences', '[]'::jsonb,
        'documents', '[]'::jsonb
      )
    ) ->> 'id'
  )::uuid;

insert into test_ids (key, value)
select
  'lesson_two',
  (
    private.api_lesson_create(
      jsonb_build_object(
        'collectionId', (select value from test_ids where key = 'collection_two'),
        'unitId', (select value from test_ids where key = 'unit_two'),
        'unitRevision', 1,
        'title', 'Outsider private draft',
        'languageCode', 'en',
        'payload', jsonb_build_object(
          'schemaVersion', 8,
          'questions',
          jsonb_build_array(
            jsonb_build_object(
              'questionId', 'q-outside',
              'tracking', jsonb_build_object(
                'encountered', jsonb_build_object(
                  'words', jsonb_build_array('outside'),
                  'phrases', '[]'::jsonb,
                  'sentences', '[]'::jsonb
                ),
                'assessed', jsonb_build_object(
                  'words', jsonb_build_array('outside'),
                  'phrases', '[]'::jsonb,
                  'sentences', '[]'::jsonb
                )
              )
            )
          )
        )
      )
    ) ->> 'id'
  )::uuid;

insert into test_ids (key, value)
select
  'progress_outsider',
  (
    private.api_progress_start(
      jsonb_build_object(
        'lessonId', (select value from test_ids where key = 'lesson_two'),
        'idempotencyKey', 'progress-start-outsider-01'
      )
    ) ->> 'id'
  )::uuid;

select private.api_progress_submit_batch(
  jsonb_build_object(
    'batchId', '20000000-0000-0000-0000-000000000003',
    'progressId', (select value from test_ids where key = 'progress_outsider'),
    'events', jsonb_build_array(
      jsonb_build_object(
        'eventId', '30000000-0000-0000-0000-000000000003',
        'attemptId', '40000000-0000-0000-0000-000000000003',
        'questionId', 'q-outside',
        'attemptNumber', 1,
        'answer', 'outside',
        'status', 'correct',
        'score', 1,
        'answeredAt', '2000-01-03T00:00:00Z',
        'evaluationSource', 'client_extension'
      )
    )
  )
);

select private.api_character_progress_upsert(
  jsonb_build_object(
    'languageCode', 'en',
    'characters', '{"o":{"encounterCount":1}}'::jsonb,
    'expectedRevision', 0
  )
);

insert into app.settings (scope_type, user_id, collection_id, key, value)
values
  (
    'user',
    '10000000-0000-0000-0000-000000000003',
    null,
    'outsider.private',
    '{"theme":"outsider"}'
  ),
  (
    'collection',
    null,
    (select value from test_ids where key = 'collection_two'),
    'collection.hidden',
    '{"locale":"fr"}'
  );

select set_config(
  'test.collection_one',
  (select value::text from test_ids where key = 'collection_one'),
  true
);
select set_config(
  'test.collection_two',
  (select value::text from test_ids where key = 'collection_two'),
  true
);
select set_config(
  'test.unit_one',
  (select value::text from test_ids where key = 'unit_one'),
  true
);
select set_config(
  'test.unit_two',
  (select value::text from test_ids where key = 'unit_two'),
  true
);
select set_config(
  'test.lesson_one',
  (select value::text from test_ids where key = 'lesson_one'),
  true
);
select set_config(
  'test.lesson_private',
  (select value::text from test_ids where key = 'lesson_private'),
  true
);
select set_config(
  'test.lesson_two',
  (select value::text from test_ids where key = 'lesson_two'),
  true
);
select set_config(
  'test.progress_one',
  (select value::text from test_ids where key = 'progress_one'),
  true
);
select set_config(
  'test.progress_member',
  (select value::text from test_ids where key = 'progress_member'),
  true
);
select set_config(
  'test.progress_outsider',
  (select value::text from test_ids where key = 'progress_outsider'),
  true
);

set local role meoing_runtime;

select ok(
  (
    select bool_and(
      has_table_privilege(
        'meoing_runtime',
        format('app.%I', target.table_name),
        'select'
      )
      and not has_table_privilege(
        'meoing_runtime',
        format('app.%I', target.table_name),
        'insert'
      )
      and not has_table_privilege(
        'meoing_runtime',
        format('app.%I', target.table_name),
        'update'
      )
      and not has_table_privilege(
        'meoing_runtime',
        format('app.%I', target.table_name),
        'delete'
      )
    )
    from (
      values
        ('settings'),
        ('collection_roles'),
        ('collection_member_roles'),
        ('collection_invites'),
        ('collection_invite_roles'),
        ('units'),
        ('unit_revisions'),
        ('lessons'),
        ('lesson_progress'),
        ('progress_batches'),
        ('user_language_stats'),
        ('collection_user_language_stats'),
        ('user_character_progress'),
        ('file_assets')
    ) as target(table_name)
  ),
  'runtime table access is read-only and all mutations remain behind RPCs'
);

select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000002',
  true
);

select is(
  (select array_agg(key order by key) from app.settings),
  array[
    'collection.shared',
    'member.collection-user',
    'member.private'
  ]::text[],
  'member RLS exposes shared, own-user, and own collection-user settings only'
);

select is(
  jsonb_build_object(
    'shared',
    (
      select count(*)
      from app.collection_roles
      where collection_id = current_setting('test.collection_one')::uuid
    ),
    'foreign',
    (
      select count(*)
      from app.collection_roles
      where collection_id = current_setting('test.collection_two')::uuid
    )
  ),
  '{"shared":4,"foreign":0}'::jsonb,
  'member RLS exposes roles in the shared collection and hides foreign roles'
);

select is(
  jsonb_build_object(
    'shared',
    (
      select count(*)
      from app.collection_member_roles
      where collection_id = current_setting('test.collection_one')::uuid
    ),
    'foreign',
    (
      select count(*)
      from app.collection_member_roles
      where collection_id = current_setting('test.collection_two')::uuid
    )
  ),
  '{"shared":3,"foreign":0}'::jsonb,
  'member RLS exposes shared role assignments without leaking foreign assignments'
);

select is(
  jsonb_build_object(
    'invites', (select count(*) from app.collection_invites),
    'inviteRoles', (select count(*) from app.collection_invite_roles)
  ),
  '{"invites":0,"inviteRoles":0}'::jsonb,
  'a member without manage-invites cannot inspect invite hashes or invite roles'
);

select is(
  jsonb_build_object(
    'shared',
    (
      select count(*)
      from app.units
      where id = current_setting('test.unit_one')::uuid
    ),
    'foreign',
    (
      select count(*)
      from app.units
      where id = current_setting('test.unit_two')::uuid
    )
  ),
  '{"shared":1,"foreign":0}'::jsonb,
  'member RLS exposes shared units and hides foreign units'
);

select is(
  jsonb_build_object(
    'shared',
    (
      select count(*)
      from app.unit_revisions
      where unit_id = current_setting('test.unit_one')::uuid
    ),
    'foreign',
    (
      select count(*)
      from app.unit_revisions
      where unit_id = current_setting('test.unit_two')::uuid
    )
  ),
  '{"shared":3,"foreign":0}'::jsonb,
  'member RLS exposes shared revision snapshots and hides foreign snapshots'
);

select is(
  jsonb_build_object(
    'published',
    (
      select count(*)
      from app.lessons
      where id = current_setting('test.lesson_one')::uuid
    ),
    'privateDraft',
    (
      select count(*)
      from app.lessons
      where id = current_setting('test.lesson_private')::uuid
    ),
    'foreign',
    (
      select count(*)
      from app.lessons
      where id = current_setting('test.lesson_two')::uuid
    )
  ),
  '{"published":1,"privateDraft":0,"foreign":0}'::jsonb,
  'member RLS exposes published lessons but hides another author draft and foreign lessons'
);

select is(
  jsonb_build_object(
    'own',
    (
      select count(*)
      from app.lesson_progress
      where id = current_setting('test.progress_member')::uuid
    ),
    'owner',
    (
      select count(*)
      from app.lesson_progress
      where id = current_setting('test.progress_one')::uuid
    ),
    'foreign',
    (
      select count(*)
      from app.lesson_progress
      where id = current_setting('test.progress_outsider')::uuid
    )
  ),
  '{"own":1,"owner":0,"foreign":0}'::jsonb,
  'lesson progress RLS exposes only the current user sessions'
);

select is(
  jsonb_build_object(
    'own',
    (
      select count(*)
      from app.progress_batches
      where batch_id = '20000000-0000-0000-0000-000000000002'
    ),
    'owner',
    (
      select count(*)
      from app.progress_batches
      where batch_id = '20000000-0000-0000-0000-000000000001'
    ),
    'foreign',
    (
      select count(*)
      from app.progress_batches
      where batch_id = '20000000-0000-0000-0000-000000000003'
    )
  ),
  '{"own":1,"owner":0,"foreign":0}'::jsonb,
  'progress batch RLS exposes only the current user idempotency records'
);

select is(
  jsonb_build_object(
    'rows', (select count(*) from app.user_language_stats),
    'own',
    (
      select count(*)
      from app.user_language_stats
      where user_id = '10000000-0000-0000-0000-000000000002'
    ),
    'owner',
    (
      select count(*)
      from app.user_language_stats
      where user_id = '10000000-0000-0000-0000-000000000001'
    ),
    'foreign',
    (
      select count(*)
      from app.user_language_stats
      where user_id = '10000000-0000-0000-0000-000000000003'
    )
  ),
  '{"rows":1,"own":1,"owner":0,"foreign":0}'::jsonb,
  'global language stats remain private even when users share a collection'
);

select is(
  jsonb_build_object(
    'shared',
    (
      select count(*)
      from app.collection_user_language_stats
      where collection_id = current_setting('test.collection_one')::uuid
    ),
    'foreign',
    (
      select count(*)
      from app.collection_user_language_stats
      where collection_id = current_setting('test.collection_two')::uuid
    )
  ),
  '{"shared":2,"foreign":0}'::jsonb,
  'view-member-progress exposes collection stats for peers without leaking another collection'
);

select is(
  jsonb_build_object(
    'own',
    (
      select count(*)
      from app.user_character_progress
      where user_id = '10000000-0000-0000-0000-000000000002'
    ),
    'owner',
    (
      select count(*)
      from app.user_character_progress
      where user_id = '10000000-0000-0000-0000-000000000001'
    ),
    'foreign',
    (
      select count(*)
      from app.user_character_progress
      where user_id = '10000000-0000-0000-0000-000000000003'
    )
  ),
  '{"own":1,"owner":0,"foreign":0}'::jsonb,
  'character progress RLS remains user-private'
);

select is(
  jsonb_build_object(
    'shared',
    (
      select count(*)
      from app.file_assets
      where id = '50000000-0000-4000-8000-000000000001'
    ),
    'foreign',
    (
      select count(*)
      from app.file_assets
      where id = '50000000-0000-4000-8000-000000000002'
    ),
    'ownerPrivate',
    (
      select count(*)
      from app.file_assets
      where id = '50000000-0000-4000-8000-000000000003'
    )
  ),
  '{"shared":1,"foreign":0,"ownerPrivate":0}'::jsonb,
  'asset RLS exposes collection files but hides foreign and another user private files'
);

select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000001',
  true
);

select is(
  (select array_agg(key order by key) from app.settings),
  array[
    'collection.shared',
    'member.collection-user',
    'owner.collection-user',
    'owner.private'
  ]::text[],
  'owner RLS exposes own settings plus managed collection-user settings'
);

select is(
  jsonb_build_object(
    'shared',
    (
      select count(*)
      from app.collection_roles
      where collection_id = current_setting('test.collection_one')::uuid
    ),
    'foreign',
    (
      select count(*)
      from app.collection_roles
      where collection_id = current_setting('test.collection_two')::uuid
    )
  ),
  '{"shared":4,"foreign":0}'::jsonb,
  'owner RLS exposes owned collection roles and hides foreign roles'
);

select is(
  jsonb_build_object(
    'invites',
    (
      select count(*)
      from app.collection_invites
      where collection_id = current_setting('test.collection_one')::uuid
    ),
    'inviteRoles',
    (
      select count(*)
      from app.collection_invite_roles
      where collection_id = current_setting('test.collection_one')::uuid
    ),
    'foreignInvites',
    (
      select count(*)
      from app.collection_invites
      where collection_id = current_setting('test.collection_two')::uuid
    )
  ),
  '{"invites":1,"inviteRoles":1,"foreignInvites":0}'::jsonb,
  'owner RLS exposes managed invites and their roles without leaking foreign invites'
);

select is(
  jsonb_build_object(
    'units',
    (
      select count(*)
      from app.units
      where collection_id = current_setting('test.collection_one')::uuid
    ),
    'revisions',
    (
      select count(*)
      from app.unit_revisions
      where collection_id = current_setting('test.collection_one')::uuid
    ),
    'foreignUnits',
    (
      select count(*)
      from app.units
      where collection_id = current_setting('test.collection_two')::uuid
    )
  ),
  '{"units":1,"revisions":3,"foreignUnits":0}'::jsonb,
  'owner RLS exposes owned unit content and revisions without leaking foreign content'
);

select is(
  jsonb_build_object(
    'published',
    (
      select count(*)
      from app.lessons
      where id = current_setting('test.lesson_one')::uuid
    ),
    'ownDraft',
    (
      select count(*)
      from app.lessons
      where id = current_setting('test.lesson_private')::uuid
    ),
    'foreign',
    (
      select count(*)
      from app.lessons
      where id = current_setting('test.lesson_two')::uuid
    )
  ),
  '{"published":1,"ownDraft":1,"foreign":0}'::jsonb,
  'lesson RLS exposes an author draft and published lesson while hiding a foreign draft'
);

select is(
  jsonb_build_object(
    'own',
    (
      select count(*)
      from app.lesson_progress
      where id = current_setting('test.progress_one')::uuid
    ),
    'member',
    (
      select count(*)
      from app.lesson_progress
      where id = current_setting('test.progress_member')::uuid
    ),
    'foreign',
    (
      select count(*)
      from app.lesson_progress
      where id = current_setting('test.progress_outsider')::uuid
    )
  ),
  '{"own":1,"member":0,"foreign":0}'::jsonb,
  'even a collection owner cannot bypass direct lesson-progress RLS'
);

select is(
  jsonb_build_object(
    'rows', (select count(*) from app.user_language_stats),
    'own',
    (
      select count(*)
      from app.user_language_stats
      where user_id = '10000000-0000-0000-0000-000000000001'
    )
  ),
  '{"rows":1,"own":1}'::jsonb,
  'even a collection owner cannot bypass global stats privacy'
);

select is(
  jsonb_build_object(
    'shared',
    (
      select count(*)
      from app.collection_user_language_stats
      where collection_id = current_setting('test.collection_one')::uuid
    ),
    'foreign',
    (
      select count(*)
      from app.collection_user_language_stats
      where collection_id = current_setting('test.collection_two')::uuid
    )
  ),
  '{"shared":2,"foreign":0}'::jsonb,
  'owner permission exposes member collection stats only inside the owned collection'
);

select is(
  jsonb_build_object(
    'own',
    (
      select count(*)
      from app.user_character_progress
      where user_id = '10000000-0000-0000-0000-000000000001'
    ),
    'member',
    (
      select count(*)
      from app.user_character_progress
      where user_id = '10000000-0000-0000-0000-000000000002'
    )
  ),
  '{"own":1,"member":0}'::jsonb,
  'collection ownership does not expose another user character progress'
);

select is(
  jsonb_build_object(
    'collection',
    (
      select count(*)
      from app.file_assets
      where id = '50000000-0000-4000-8000-000000000001'
    ),
    'private',
    (
      select count(*)
      from app.file_assets
      where id = '50000000-0000-4000-8000-000000000003'
    ),
    'foreign',
    (
      select count(*)
      from app.file_assets
      where id = '50000000-0000-4000-8000-000000000002'
    )
  ),
  '{"collection":1,"private":1,"foreign":0}'::jsonb,
  'asset RLS exposes owner and owned-collection files while hiding foreign files'
);

select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000003',
  true
);

select is(
  (select array_agg(key order by key) from app.settings),
  array['collection.hidden', 'outsider.private']::text[],
  'outsider RLS exposes only own user settings and owned collection settings'
);

select is(
  jsonb_build_object(
    'own',
    (
      select count(*)
      from app.collection_roles
      where collection_id = current_setting('test.collection_two')::uuid
    ),
    'foreign',
    (
      select count(*)
      from app.collection_roles
      where collection_id = current_setting('test.collection_one')::uuid
    )
  ),
  '{"own":2,"foreign":0}'::jsonb,
  'outsider RLS exposes roles only in the collection they own'
);

select is(
  jsonb_build_object(
    'invites',
    (
      select count(*)
      from app.collection_invites
      where collection_id = current_setting('test.collection_two')::uuid
    ),
    'inviteRoles',
    (
      select count(*)
      from app.collection_invite_roles
      where collection_id = current_setting('test.collection_two')::uuid
    ),
    'foreignInvites',
    (
      select count(*)
      from app.collection_invites
      where collection_id = current_setting('test.collection_one')::uuid
    )
  ),
  '{"invites":1,"inviteRoles":1,"foreignInvites":0}'::jsonb,
  'outsider owner can inspect own invites and roles but not another collection invites'
);

select is(
  jsonb_build_object(
    'units',
    (
      select count(*)
      from app.units
      where collection_id = current_setting('test.collection_two')::uuid
    ),
    'revisions',
    (
      select count(*)
      from app.unit_revisions
      where collection_id = current_setting('test.collection_two')::uuid
    ),
    'foreignUnits',
    (
      select count(*)
      from app.units
      where collection_id = current_setting('test.collection_one')::uuid
    )
  ),
  '{"units":1,"revisions":1,"foreignUnits":0}'::jsonb,
  'outsider RLS exposes own unit and revision while hiding another collection content'
);

select is(
  jsonb_build_object(
    'ownDraft',
    (
      select count(*)
      from app.lessons
      where id = current_setting('test.lesson_two')::uuid
    ),
    'foreign',
    (
      select count(*)
      from app.lessons
      where collection_id = current_setting('test.collection_one')::uuid
    )
  ),
  '{"ownDraft":1,"foreign":0}'::jsonb,
  'outsider lesson RLS exposes its own draft and hides all foreign lessons'
);

select is(
  jsonb_build_object(
    'own',
    (
      select count(*)
      from app.lesson_progress
      where id = current_setting('test.progress_outsider')::uuid
    ),
    'foreign',
    (
      select count(*)
      from app.lesson_progress
      where collection_id = current_setting('test.collection_one')::uuid
    )
  ),
  '{"own":1,"foreign":0}'::jsonb,
  'outsider lesson-progress RLS exposes only its own session'
);

select is(
  jsonb_build_object(
    'own',
    (
      select count(*)
      from app.progress_batches
      where batch_id = '20000000-0000-0000-0000-000000000003'
    ),
    'foreign',
    (
      select count(*)
      from app.progress_batches
      where batch_id in (
        '20000000-0000-0000-0000-000000000001',
        '20000000-0000-0000-0000-000000000002'
      )
    )
  ),
  '{"own":1,"foreign":0}'::jsonb,
  'outsider progress-batch RLS hides every other user idempotency record'
);

select is(
  jsonb_build_object(
    'rows', (select count(*) from app.user_language_stats),
    'own',
    (
      select count(*)
      from app.user_language_stats
      where user_id = '10000000-0000-0000-0000-000000000003'
    )
  ),
  '{"rows":1,"own":1}'::jsonb,
  'outsider global stats RLS exposes only its own aggregate'
);

select is(
  jsonb_build_object(
    'own',
    (
      select count(*)
      from app.collection_user_language_stats
      where collection_id = current_setting('test.collection_two')::uuid
    ),
    'foreign',
    (
      select count(*)
      from app.collection_user_language_stats
      where collection_id = current_setting('test.collection_one')::uuid
    )
  ),
  '{"own":1,"foreign":0}'::jsonb,
  'outsider collection stats RLS exposes own aggregate and hides foreign aggregates'
);

select is(
  jsonb_build_object(
    'own',
    (
      select count(*)
      from app.user_character_progress
      where user_id = '10000000-0000-0000-0000-000000000003'
    ),
    'foreign',
    (
      select count(*)
      from app.user_character_progress
      where user_id <> '10000000-0000-0000-0000-000000000003'
    )
  ),
  '{"own":1,"foreign":0}'::jsonb,
  'outsider character progress RLS exposes only its own language row'
);

select is(
  jsonb_build_object(
    'own',
    (
      select count(*)
      from app.file_assets
      where id = '50000000-0000-4000-8000-000000000002'
    ),
    'foreignCollection',
    (
      select count(*)
      from app.file_assets
      where id = '50000000-0000-4000-8000-000000000001'
    ),
    'foreignPrivate',
    (
      select count(*)
      from app.file_assets
      where id = '50000000-0000-4000-8000-000000000003'
    )
  ),
  '{"own":1,"foreignCollection":0,"foreignPrivate":0}'::jsonb,
  'outsider asset RLS exposes its collection file and hides all foreign files'
);

select set_config('app.user_id', '', true);

select is(
  jsonb_build_object(
    'settings', (select count(*) from app.settings),
    'roles', (select count(*) from app.collection_roles),
    'invites', (select count(*) from app.collection_invites),
    'units', (select count(*) from app.units),
    'revisions', (select count(*) from app.unit_revisions),
    'lessons', (select count(*) from app.lessons),
    'progress', (select count(*) from app.lesson_progress),
    'batches', (select count(*) from app.progress_batches),
    'globalStats', (select count(*) from app.user_language_stats),
    'collectionStats', (select count(*) from app.collection_user_language_stats),
    'characters', (select count(*) from app.user_character_progress),
    'assets', (select count(*) from app.file_assets)
  ),
  '{
    "settings": 0,
    "roles": 0,
    "invites": 0,
    "units": 0,
    "revisions": 0,
    "lessons": 0,
    "progress": 0,
    "batches": 0,
    "globalStats": 0,
    "collectionStats": 0,
    "characters": 0,
    "assets": 0
  }'::jsonb,
  'runtime RLS returns no application rows when the request actor is absent'
);

reset role;
select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000001',
  true
);

select private.api_role_update(
  jsonb_build_object(
    'collectionId', (select value from test_ids where key = 'collection_one'),
    'roleId', (select value from test_ids where key = 'teacher_role'),
    'name', 'Teacher updated',
    'permissions', jsonb_build_array(
      'create_content',
      'edit_content',
      'create_lessons',
      'publish_lessons'
    ),
    'securityRank', 11,
    'expectedRevision', 1
  )
);

select private.api_collection_transfer(
  jsonb_build_object(
    'collectionId', (select value from test_ids where key = 'collection_one'),
    'newOwnerId', '10000000-0000-0000-0000-000000000002',
    'expectedRevision', 1
  )
);

select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000002',
  true
);

select private.api_collection_transfer(
  jsonb_build_object(
    'collectionId', (select value from test_ids where key = 'collection_one'),
    'newOwnerId', '10000000-0000-0000-0000-000000000001',
    'expectedRevision', 2
  )
);

select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000001',
  true
);

select is(
  (
    select jsonb_build_object(
      'targetId', target_id,
      'metadata', metadata
    )
    from app.collection_audit_logs
    where collection_id = (select value from test_ids where key = 'collection_one')
      and action = 'collection_member_roles.insert'
      and metadata ->> 'roleId' = (
        select value::text from test_ids where key = 'teacher_role'
      )
    order by id desc
    limit 1
  ),
  jsonb_build_object(
    'targetId', (select value from test_ids where key = 'teacher_role'),
    'metadata', jsonb_build_object(
      'schemaVersion', 2,
      'userId', '10000000-0000-0000-0000-000000000002'::uuid,
      'roleId', (select value from test_ids where key = 'teacher_role')
    )
  ),
  'member-role audit keeps role target identity and records userId plus roleId'
);

select is(
  (
    select jsonb_build_object(
      'targetId', audit.target_id,
      'metadata', audit.metadata
    )
    from app.collection_audit_logs as audit
    where audit.collection_id = (
        select value from test_ids where key = 'collection_one'
      )
      and audit.action = 'collection_invite_roles.insert'
      and audit.metadata ->> 'roleId' = (
        select value::text from test_ids where key = 'teacher_role'
      )
    order by audit.id desc
    limit 1
  ),
  (
    select jsonb_build_object(
      'targetId', (select value from test_ids where key = 'teacher_role'),
      'metadata', jsonb_build_object(
        'schemaVersion', 2,
        'inviteId', invite.id,
        'roleId', (select value from test_ids where key = 'teacher_role')
      )
    )
    from app.collection_invites as invite
    where invite.collection_id = (
      select value from test_ids where key = 'collection_one'
    )
    order by invite.id
    limit 1
  ),
  'invite-role audit keeps role target identity and records inviteId plus roleId'
);

select is(
  (
    select metadata
    from app.collection_audit_logs
    where collection_id = (select value from test_ids where key = 'collection_one')
      and action = 'collection_roles.update'
      and target_id = (select value from test_ids where key = 'teacher_role')
    order by id desc
    limit 1
  ),
  jsonb_build_object(
    'schemaVersion', 2,
    'revision', 2,
    'old', jsonb_build_object(
      'name', 'Teacher',
      'permissions', jsonb_build_array(
        'create_content',
        'edit_content',
        'create_lessons'
      ),
      'securityRank', 10
    ),
    'new', jsonb_build_object(
      'name', 'Teacher updated',
      'permissions', jsonb_build_array(
        'create_content',
        'edit_content',
        'create_lessons',
        'publish_lessons'
      ),
      'securityRank', 11
    )
  ),
  'role audit metadata follows the explicit revision and old/new field allowlist'
);

select is(
  (
    select jsonb_agg(
      jsonb_build_object(
        'schemaVersion', metadata -> 'schemaVersion',
        'oldOwnerId', metadata -> 'oldOwnerId',
        'newOwnerId', metadata -> 'newOwnerId'
      )
      order by id
    )
    from app.collection_audit_logs
    where collection_id = (select value from test_ids where key = 'collection_one')
      and action = 'collections.update'
      and metadata ?& array['oldOwnerId', 'newOwnerId']
  ),
  jsonb_build_array(
    jsonb_build_object(
      'schemaVersion', 2,
      'oldOwnerId', '10000000-0000-0000-0000-000000000001'::uuid,
      'newOwnerId', '10000000-0000-0000-0000-000000000002'::uuid
    ),
    jsonb_build_object(
      'schemaVersion', 2,
      'oldOwnerId', '10000000-0000-0000-0000-000000000002'::uuid,
      'newOwnerId', '10000000-0000-0000-0000-000000000001'::uuid
    )
  ),
  'ownership audit records the old and new owner IDs for both transfer directions'
);

select ok(
  not exists (
    with recursive audit_nodes(value) as (
      select metadata
      from app.collection_audit_logs

      union all

      select child.value
      from audit_nodes as node
      cross join lateral (
        select object_child.value
        from jsonb_each(
          case
            when jsonb_typeof(node.value) = 'object' then node.value
            else '{}'::jsonb
          end
        ) as object_child

        union all

        select array_child.value
        from jsonb_array_elements(
          case
            when jsonb_typeof(node.value) = 'array' then node.value
            else '[]'::jsonb
          end
        ) as array_child
      ) as child
    )
    select 1
    from audit_nodes as node
    cross join lateral jsonb_object_keys(
      case
        when jsonb_typeof(node.value) = 'object' then node.value
        else '{}'::jsonb
      end
    ) as key_name
    where lower(key_name) = any(array[
      'words',
      'phrases',
      'sentences',
      'documents',
      'payload',
      'answer',
      'answers',
      'transcript',
      'rawanswer'
    ])
  ),
  'audit metadata recursively excludes content, lesson payload, and answer keys'
);

select cmp_ok(
  (
    select count(*)
    from app.collection_audit_logs
    where collection_id = (select value from test_ids where key = 'collection_one')
  ),
  '>',
  0::bigint,
  'collection content and authorization changes create audit entries'
);

select throws_ok(
  $$update app.collection_audit_logs set action = 'tampered'$$,
  '42501',
  'AUDIT_LOG_IS_APPEND_ONLY',
  'audit rows cannot be rewritten'
);

select lives_ok(
  $test$
    do $body$
    begin
      for i in 1..30 loop
        perform private.api_abuse_consume(
          jsonb_build_object(
            'scope', 'username_lookup',
            'abuseKey', repeat('ef', 32)
          )
        );
      end loop;
    end
    $body$
  $test$,
  'the durable username lookup quota accepts the configured 30 requests'
);

select throws_ok(
  $$select private.api_abuse_consume(
    jsonb_build_object(
      'scope', 'username_lookup',
      'abuseKey', repeat('ef', 32)
    )
  )$$,
  '54000',
  'RATE_LIMITED',
  'the durable username lookup quota rejects request 31 atomically'
);

select is(
  (
    private.api_abuse_consume(
      jsonb_build_object(
        'scope', 'invite_accept',
        'abuseKey', repeat('ef', 32)
      )
    ) ->> 'limit'
  )::integer,
  10,
  'invite acceptance has an independent ten-per-hour abuse bucket'
);

create temporary table test_json (
  key text primary key,
  value jsonb not null
) on commit drop;

update app.collections
set deleted_at = statement_timestamp() - interval '31 days',
    delete_after = statement_timestamp() - interval '1 day'
where id = (select value from test_ids where key = 'collection_two');

select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000003',
  true
);
select throws_ok(
  format(
    $$select private.api_collection_leave(
      jsonb_build_object('collectionId', %L)
    )$$,
    (select value from test_ids where key = 'collection_two')
  ),
  '23514',
  'OWNER_CANNOT_LEAVE',
  'an owner cannot leave a soft-deleted collection'
);
select set_config(
  'app.user_id',
  '10000000-0000-0000-0000-000000000001',
  true
);

insert into test_json (key, value)
values ('cleanup_one', private.maintenance_cleanup('{"batchSize":500}'::jsonb));

select is(
  (
    (select value -> 'dueAssetIds' from test_json where key = 'cleanup_one')
    @> '["50000000-0000-4000-8000-000000000002"]'::jsonb
  ),
  true,
  'cleanup prepares collection R2 assets without deleting database rows'
);

select is(
  (
    (select value -> 'dueCollectionIds' from test_json where key = 'cleanup_one')
    @> jsonb_build_array((select value from test_ids where key = 'collection_two'))
  ),
  false,
  'a collection is not finalizable while asset rows remain'
);

select is(
  (
    private.maintenance_finalize(
      jsonb_build_object(
        'collectionIds',
        jsonb_build_array((select value from test_ids where key = 'collection_two'))
      )
    ) ->> 'deletedCollections'
  )::integer,
  0,
  'finalize independently rejects a stale collection request while R2 asset rows remain'
);

select is(
  (
    private.maintenance_finalize(
      '{"assetIds":["50000000-0000-4000-8000-000000000002"]}'::jsonb
    ) ->> 'purgedAssets'
  )::integer,
  1,
  'finalize removes an asset row only after the caller confirms R2 deletion'
);

select is(
  (
    select count(*)::integer
    from app.collections
    where id = (select value from test_ids where key = 'collection_two')
  ),
  1,
  'asset finalization keeps the due collection for the next cleanup pass'
);

insert into test_json (key, value)
values ('cleanup_two', private.maintenance_cleanup('{"batchSize":500}'::jsonb));

select is(
  (
    (select value -> 'dueCollectionIds' from test_json where key = 'cleanup_two')
    @> jsonb_build_array((select value from test_ids where key = 'collection_two'))
  ),
  true,
  'cleanup exposes a due collection only after all its R2 rows are finalized'
);

select is(
  (
    private.maintenance_finalize(
      jsonb_build_object(
        'collectionIds',
        jsonb_build_array((select value from test_ids where key = 'collection_two'))
      )
    ) ->> 'deletedCollections'
  )::integer,
  1,
  'collection finalization purges the database only after R2 succeeds'
);

select cmp_ok(
  (
    select count(*)
    from app.collection_audit_logs
    where collection_id = (select value from test_ids where key = 'collection_two')
  ),
  '>',
  0::bigint,
  'collection purge keeps audit tombstones until their independent retention date'
);

select is(
  private.maintenance_observe('{}'::jsonb)
    ?& array['globalStatsP95Bytes', 'waitingLockCount'],
  true,
  'maintenance observability returns stats-size and waiting-lock indicators'
);

set local role meoing_runtime;
select throws_ok(
  $$select private.maintenance_observe('{}'::jsonb)$$,
  '42501',
  null,
  'the runtime role cannot invoke privileged operational observations'
);
reset role;

-- The local deployment identity intentionally uses the staging 0.5 GiB cap.
-- Rows are metadata-only, so the boundary can be exercised without writing R2.
delete from app.file_assets;

select lives_ok(
  $$
    insert into app.file_assets (
      id,
      owner_id,
      r2_key,
      original_filename,
      mime_type,
      expected_size_bytes,
      expected_sha256
    )
    select
      gen_random_uuid(),
      '10000000-0000-0000-0000-000000000001'::uuid,
      'budget/' || item::text,
      'budget.bin',
      'application/pdf',
      26214400,
      decode(repeat('00', 32), 'hex')
    from generate_series(1, 20) as item
  $$,
  'storage reservations can fill the first 500 MiB of the staging budget'
);

select lives_ok(
  $$
    insert into app.file_assets (
      id,
      owner_id,
      r2_key,
      original_filename,
      mime_type,
      expected_size_bytes,
      expected_sha256
    ) values (
      gen_random_uuid(),
      '10000000-0000-0000-0000-000000000001'::uuid,
      'budget/exact-limit',
      'budget.bin',
      'application/pdf',
      12582912,
      decode(repeat('00', 32), 'hex')
    )
  $$,
  'storage reservations may reach the exact 0.5 GiB staging budget'
);

select throws_ok(
  $$
    insert into app.file_assets (
      id,
      owner_id,
      r2_key,
      original_filename,
      mime_type,
      expected_size_bytes,
      expected_sha256
    ) values (
      gen_random_uuid(),
      '10000000-0000-0000-0000-000000000001'::uuid,
      'budget/over-limit',
      'budget.bin',
      'application/pdf',
      1,
      decode(repeat('00', 32), 'hex')
    )
  $$,
  '54000',
  'STORAGE_BUDGET_REACHED',
  'the atomic storage guard rejects the first byte over budget'
);

select * from finish();
rollback;

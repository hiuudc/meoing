begin;

set local search_path = public, extensions, app, private;

select plan(76);

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
  (select count(*)::integer from app.profiles),
  3,
  'auth trigger creates one application profile per user'
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
        'documents', '[{"title":"Notes","content":{"root":{"children":[{"type":"meoi-image","assetId":"50000000-0000-4000-8000-000000000001"}]}}}]'::jsonb
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

select * from finish();
rollback;

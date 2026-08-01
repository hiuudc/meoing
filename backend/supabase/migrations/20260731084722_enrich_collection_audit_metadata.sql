create or replace function private.audit_collection_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_collection_id uuid;
  v_target_id uuid;
  v_metadata jsonb;
begin
  if tg_op <> 'INSERT' then
    v_old := to_jsonb(old);
  end if;
  if tg_op <> 'DELETE' then
    v_new := to_jsonb(new);
  end if;

  v_row := case when tg_op = 'DELETE' then v_old else v_new end;

  if tg_table_name = 'collections' then
    v_collection_id := (v_row ->> 'id')::uuid;
    v_target_id := v_collection_id;
    if tg_op = 'DELETE' then
      return old;
    end if;
  else
    v_collection_id := nullif(v_row ->> 'collection_id', '')::uuid;
    -- Keep the original target-id precedence so assignment rows retain
    -- target_id = role_id on both sides of this forward migration.
    v_target_id := coalesce(
      nullif(v_row ->> 'id', '')::uuid,
      nullif(v_row ->> 'role_id', '')::uuid,
      nullif(v_row ->> 'invite_id', '')::uuid,
      nullif(v_row ->> 'user_id', '')::uuid
    );
  end if;

  -- The default metadata is deliberately narrow: unit content, lesson payloads,
  -- answers, and other user-authored bodies must never be copied into audit rows.
  v_metadata := jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 2,
    'revision', v_row -> 'revision',
    'status', v_row -> 'status'
  ));

  if tg_table_name = 'collection_member_roles' then
    v_metadata := v_metadata || jsonb_build_object(
      'userId', v_row -> 'user_id',
      'roleId', v_row -> 'role_id'
    );
  elsif tg_table_name = 'collection_invite_roles' then
    v_metadata := v_metadata || jsonb_build_object(
      'inviteId', v_row -> 'invite_id',
      'roleId', v_row -> 'role_id'
    );
  elsif tg_table_name = 'collection_roles' then
    v_metadata := v_metadata || jsonb_strip_nulls(jsonb_build_object(
      'old', case when v_old is null then null else jsonb_build_object(
        'name', v_old -> 'name',
        'permissions', v_old -> 'permissions',
        'securityRank', v_old -> 'security_rank'
      ) end,
      'new', case when v_new is null then null else jsonb_build_object(
        'name', v_new -> 'name',
        'permissions', v_new -> 'permissions',
        'securityRank', v_new -> 'security_rank'
      ) end
    ));
  elsif tg_table_name = 'collections'
        and tg_op = 'UPDATE'
        and (v_old ->> 'owner_id') is distinct from (v_new ->> 'owner_id') then
    v_metadata := v_metadata || jsonb_build_object(
      'oldOwnerId', v_old -> 'owner_id',
      'newOwnerId', v_new -> 'owner_id'
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
      v_metadata
    );
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function private.audit_collection_change() is
  'Writes collection audit metadata from an explicit safe-field allowlist; never copies content or answers.';

begin;

-- Persisted Lexical images are references to private R2 assets. Remote URLs are
-- editing-time data only and must never be retained in a unit or revision.
create or replace function private.unit_documents_have_safe_images(p_value jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  with recursive walk(value) as (
    select p_value
    union all
    select child.value
    from walk as parent
    cross join lateral (
      select entry.value
      from jsonb_each(
        case
          when jsonb_typeof(parent.value) = 'object'
            then parent.value
          else '{}'::jsonb
        end
      ) as entry(key, value)
      union all
      select element.value
      from jsonb_array_elements(
        case
          when jsonb_typeof(parent.value) = 'array'
            then parent.value
          else '[]'::jsonb
        end
      ) as element(value)
    ) as child(value)
  )
  select not exists (
    select 1
    from walk
    where jsonb_typeof(walk.value) = 'object'
      and walk.value ->> 'type' = 'meoi-image'
      and (
        jsonb_typeof(walk.value -> 'assetId') is distinct from 'string'
        or walk.value ->> 'assetId'
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or (
          walk.value ? 'src'
          and (
            jsonb_typeof(walk.value -> 'src') is distinct from 'string'
            or walk.value ->> 'src' <> ''
          )
        )
      )
  );
$$;

-- This helper exists for the one-time legacy cleanup and as defense in depth
-- when restoring an old snapshot. An image whose asset is missing, not ready,
-- or owned by another collection is removed; an authorized image keeps its
-- node metadata but loses the transient src field.
create or replace function private.sanitize_unit_document_value(
  p_value jsonb,
  p_collection_id uuid
)
returns jsonb
language plpgsql
stable
strict
set search_path = ''
as $$
declare
  v_asset_id_text text;
  v_object jsonb := p_value;
  v_result jsonb;
begin
  if jsonb_typeof(p_value) = 'array' then
    select coalesce(
      jsonb_agg(child.value order by element.ordinality)
        filter (where child.value is not null),
      '[]'::jsonb
    )
    into v_result
    from jsonb_array_elements(p_value) with ordinality
      as element(value, ordinality)
    cross join lateral (
      select private.sanitize_unit_document_value(
        element.value,
        p_collection_id
      ) as value
    ) as child;
    return v_result;
  end if;

  if jsonb_typeof(p_value) <> 'object' then
    return p_value;
  end if;

  if p_value ->> 'type' = 'meoi-image' then
    v_asset_id_text := p_value ->> 'assetId';
    if v_asset_id_text is null
       or v_asset_id_text
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      return null;
    end if;
    if not exists (
      select 1
      from app.file_assets as asset
      where asset.id = v_asset_id_text::uuid
        and asset.collection_id = p_collection_id
        and asset.status = 'ready'
    ) then
      return null;
    end if;
    v_object := p_value - 'src';
  end if;

  select coalesce(
    jsonb_object_agg(entry.key, child.value)
      filter (where child.value is not null),
    '{}'::jsonb
  )
  into v_result
  from jsonb_each(v_object) as entry(key, value)
  cross join lateral (
    select private.sanitize_unit_document_value(
      entry.value,
      p_collection_id
    ) as value
  ) as child;

  return v_result;
end;
$$;

create or replace function private.sanitize_unit_documents_images(
  p_documents jsonb,
  p_collection_id uuid
)
returns jsonb
language sql
stable
strict
set search_path = ''
as $$
  select private.sanitize_unit_document_value(p_documents, p_collection_id);
$$;

revoke all on function private.unit_documents_have_safe_images(jsonb)
  from public, anon, authenticated, service_role, meoing_runtime, meoing_maintenance;
revoke all on function private.sanitize_unit_document_value(jsonb, uuid)
  from public, anon, authenticated, service_role, meoing_runtime, meoing_maintenance;
revoke all on function private.sanitize_unit_documents_images(jsonb, uuid)
  from public, anon, authenticated, service_role, meoing_runtime, meoing_maintenance;

-- Preserve product timestamps and avoid synthetic collection audit entries
-- while repairing legacy content. The asset-reference trigger remains enabled
-- so reference counts still follow any image nodes removed by the cleanup.
alter table app.units disable trigger units_audit;
alter table app.units disable trigger units_touch_updated_at;

with sanitized as materialized (
  select
    unit.id,
    private.sanitize_unit_documents_images(
      unit.documents,
      unit.collection_id
    ) as documents
  from app.units as unit
)
update app.units as unit
set documents = coalesce(sanitized.documents, '[]'::jsonb)
from sanitized
where sanitized.id = unit.id
  and unit.documents is distinct from coalesce(sanitized.documents, '[]'::jsonb);

alter table app.units enable trigger units_touch_updated_at;
alter table app.units enable trigger units_audit;

with sanitized as materialized (
  select
    revision.id,
    private.sanitize_unit_documents_images(
      coalesce(revision.snapshot -> 'documents', '[]'::jsonb),
      revision.collection_id
    ) as documents
  from app.unit_revisions as revision
)
update app.unit_revisions as revision
set snapshot = jsonb_set(
  revision.snapshot,
  '{documents}',
  coalesce(sanitized.documents, '[]'::jsonb),
  true
)
from sanitized
where sanitized.id = revision.id
  and coalesce(revision.snapshot -> 'documents', '[]'::jsonb)
    is distinct from coalesce(sanitized.documents, '[]'::jsonb);

alter table app.units
  add constraint units_persisted_images_are_asset_backed
  check (private.unit_documents_have_safe_images(documents))
  not valid;
alter table app.units
  validate constraint units_persisted_images_are_asset_backed;

alter table app.unit_revisions
  add constraint unit_revisions_persisted_images_are_asset_backed
  check (
    private.unit_documents_have_safe_images(
      coalesce(snapshot -> 'documents', '[]'::jsonb)
    )
  )
  not valid;
alter table app.unit_revisions
  validate constraint unit_revisions_persisted_images_are_asset_backed;

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
  v_documents jsonb;
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

  v_documents := coalesce(
    private.sanitize_unit_documents_images(
      coalesce(v_source.snapshot -> 'documents', '[]'::jsonb),
      v_unit.collection_id
    ),
    '[]'::jsonb
  );

  if not private.unit_documents_have_safe_images(v_documents) then
    raise exception using errcode = '22023', message = 'INVALID_DOCUMENT_IMAGE';
  end if;

  update app.units
  set name = v_source.snapshot ->> 'name',
      description = v_source.snapshot ->> 'description',
      instruction_override = v_source.snapshot ->> 'instructionOverride',
      language_code = v_source.snapshot ->> 'languageCode',
      words = v_source.snapshot -> 'words',
      phrases = v_source.snapshot -> 'phrases',
      sentences = v_source.snapshot -> 'sentences',
      documents = v_documents,
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

commit;

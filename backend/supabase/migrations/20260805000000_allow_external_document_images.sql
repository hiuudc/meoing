begin;

-- Document images can be either a collection-owned R2 asset or an external
-- HTTPS URL. They must never contain both sources or a local data URL.
alter table app.units
  drop constraint units_persisted_images_are_asset_backed;
alter table app.unit_revisions
  drop constraint unit_revisions_persisted_images_are_asset_backed;

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
      and not (
        (
          jsonb_typeof(walk.value -> 'assetId') = 'string'
          and walk.value ->> 'assetId'
            ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          and (
            not (walk.value ? 'src')
            or (
              jsonb_typeof(walk.value -> 'src') = 'string'
              and walk.value ->> 'src' = ''
            )
          )
        )
        or (
          not (walk.value ? 'assetId')
          and jsonb_typeof(walk.value -> 'src') = 'string'
          and walk.value ->> 'src' ~* '^https://[^[:space:]]+$'
        )
      )
  );
$$;

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
    if v_asset_id_text is not null then
      if v_asset_id_text
         !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or not exists (
           select 1
           from app.file_assets as asset
           where asset.id = v_asset_id_text::uuid
             and asset.collection_id = p_collection_id
             and asset.status = 'ready'
         ) then
        return null;
      end if;
      v_object := p_value - 'src';
    elsif jsonb_typeof(p_value -> 'src') <> 'string'
      or p_value ->> 'src' !~* '^https://[^[:space:]]+$' then
      return null;
    else
      v_object := p_value - 'assetId';
    end if;
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

revoke all on function private.unit_documents_have_safe_images(jsonb)
  from public, anon, authenticated, service_role, meoing_runtime, meoing_maintenance;
revoke all on function private.sanitize_unit_document_value(jsonb, uuid)
  from public, anon, authenticated, service_role, meoing_runtime, meoing_maintenance;

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

commit;

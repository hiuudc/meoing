#!/usr/bin/env bash
set -euo pipefail

drill_dir="$(mktemp -d)"
trap 'rm -rf -- "$drill_dir"' EXIT

latest_key="$(
  aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3api list-objects-v2 \
    --bucket "$R2_BACKUP_BUCKET" \
    --prefix daily/ \
    --query 'sort_by(Contents,&LastModified)[-1].Key' \
    --output text
)"
test -n "$latest_key"
test "$latest_key" != "None"

encrypted_bundle="${drill_dir}/backup.tar.age"
plain_bundle="${drill_dir}/backup.tar"
restore_dir="${drill_dir}/restored"
identity_file="${drill_dir}/identity.txt"
printf '%s\n' "$BACKUP_AGE_IDENTITY" > "$identity_file"
chmod 600 "$identity_file"

aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3 cp \
  "s3://${R2_BACKUP_BUCKET}/${latest_key}" "$encrypted_bundle" \
  --only-show-errors
age --decrypt --identity "$identity_file" --output "$plain_bundle" "$encrypted_bundle"

mapfile -t bundle_entries < <(tar --list --file "$plain_bundle" | sort)
if [[ "${bundle_entries[*]}" != "manifest.json meoing.dump" ]]; then
  echo "Backup bundle contains unexpected paths" >&2
  exit 1
fi
mkdir --parents "$restore_dir"
tar --extract --file "$plain_bundle" --directory "$restore_dir"
plain_dump="${restore_dir}/meoing.dump"
manifest="${restore_dir}/manifest.json"
expected_sha256="$(jq --exit-status --raw-output '.dumpSha256' "$manifest")"
actual_sha256="$(sha256sum "$plain_dump" | awk '{print $1}')"
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  echo "Backup dump checksum does not match its encrypted manifest" >&2
  exit 1
fi

if [[ "${RESTORE_DRILL_SCHEMA_READY:-0}" != "1" ]]; then
  for migration in backend/supabase/migrations/*.sql; do
    psql "$RESTORE_DRILL_DATABASE_URL" --set ON_ERROR_STOP=1 --file "$migration"
  done
fi

psql "$RESTORE_DRILL_DATABASE_URL" --set ON_ERROR_STOP=1 <<'SQL'
do $$
declare
  app_tables text;
begin
  select string_agg(format('%I.%I', schemaname, tablename), ', ' order by tablename)
  into app_tables
  from pg_catalog.pg_tables
  where schemaname = 'app';

  if app_tables is null then
    raise exception 'The app schema has no tables';
  end if;
  execute 'truncate table ' || app_tables
    || ', auth.identities, auth.users restart identity cascade';
end;
$$;
SQL

pg_restore \
  --dbname="$RESTORE_DRILL_DATABASE_URL" \
  --no-owner \
  --no-acl \
  --data-only \
  --disable-triggers \
  --exit-on-error \
  "$plain_dump"

psql "$RESTORE_DRILL_DATABASE_URL" --set ON_ERROR_STOP=1 <<'SQL'
create temporary table restore_fk_definitions as
select
  constraint_row.conrelid::regclass::text as relation_name,
  constraint_row.conname as constraint_name,
  pg_catalog.pg_get_constraintdef(constraint_row.oid) as definition
from pg_catalog.pg_constraint as constraint_row
join pg_catalog.pg_class as relation on relation.oid = constraint_row.conrelid
join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
where constraint_row.contype = 'f'
  and (
    namespace.nspname = 'app'
    or (namespace.nspname = 'auth' and relation.relname in ('users', 'identities'))
  );

do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select * from restore_fk_definitions
  loop
    execute format(
      'alter table %s drop constraint %I',
      constraint_row.relation_name,
      constraint_row.constraint_name
    );
  end loop;

  for constraint_row in
    select * from restore_fk_definitions
  loop
    execute format(
      'alter table %s add constraint %I %s not valid',
      constraint_row.relation_name,
      constraint_row.constraint_name,
      constraint_row.definition
    );
    execute format(
      'alter table %s validate constraint %I',
      constraint_row.relation_name,
      constraint_row.constraint_name
    );
  end loop;
end;
$$;

do $$
declare
  mismatches bigint;
begin
  with references as (
    select unit.collection_id, reference.asset_id
    from app.units as unit
    cross join lateral private.asset_reference_ids(unit.documents) as reference
    union all
    select revision.collection_id, reference.asset_id
    from app.unit_revisions as revision
    cross join lateral private.asset_reference_ids(
      coalesce(revision.snapshot -> 'documents', '[]'::jsonb)
    ) as reference
    union all
    select lesson.collection_id, reference.asset_id
    from app.lessons as lesson
    cross join lateral private.asset_reference_ids(lesson.payload) as reference
  ),
  expected as (
    select asset_id, count(*)::bigint as reference_count
    from references
    group by asset_id
  )
  select count(*)
  into mismatches
  from app.file_assets as asset
  full join expected on expected.asset_id = asset.id
  where asset.id is null
     or coalesce(asset.reference_count, 0) <> coalesce(expected.reference_count, 0);

  if mismatches > 0 then
    raise exception 'Restored asset reference counts are inconsistent';
  end if;

  if exists (
    with references as (
      select unit.collection_id, reference.asset_id
      from app.units as unit
      cross join lateral private.asset_reference_ids(unit.documents) as reference
      union all
      select revision.collection_id, reference.asset_id
      from app.unit_revisions as revision
      cross join lateral private.asset_reference_ids(
        coalesce(revision.snapshot -> 'documents', '[]'::jsonb)
      ) as reference
      union all
      select lesson.collection_id, reference.asset_id
      from app.lessons as lesson
      cross join lateral private.asset_reference_ids(lesson.payload) as reference
    )
    select 1
    from references
    left join app.file_assets as asset on asset.id = references.asset_id
    where asset.id is null
       or asset.collection_id is distinct from references.collection_id
       or asset.status <> 'ready'
  ) then
    raise exception 'Restored content has an invalid asset reference';
  end if;
end;
$$;
SQL

relations=(
  auth.users
  auth.identities
  app.profiles
  app.username_reservations
  app.collections
  app.collection_members
  app.collection_profiles
  app.collection_roles
  app.collection_member_roles
  app.collection_invites
  app.collection_invite_roles
  app.settings
  app.units
  app.unit_revisions
  app.collection_audit_logs
  app.lessons
  app.lesson_progress
  app.progress_batches
  app.user_language_stats
  app.collection_user_language_stats
  app.user_character_progress
  app.file_assets
)
count_arguments=()
for relation in "${relations[@]}"; do
  count_arguments+=("'${relation}'" "(select count(*) from ${relation})")
done
printf -v joined_count_arguments '%s,' "${count_arguments[@]}"
count_sql="select jsonb_build_object('tables', jsonb_build_object(${joined_count_arguments%,}));"
actual_counts="$(
  psql "$RESTORE_DRILL_DATABASE_URL" \
    --set ON_ERROR_STOP=1 \
    --quiet \
    --tuples-only \
    --no-align \
    --command "$count_sql" |
    jq --compact-output --sort-keys '.tables'
)"
expected_counts="$(jq --compact-output --sort-keys '.tables' "$manifest")"
if [[ "$actual_counts" != "$expected_counts" ]]; then
  echo "Restored row counts do not match the encrypted backup manifest" >&2
  diff <(printf '%s\n' "$expected_counts") <(printf '%s\n' "$actual_counts") || true
  exit 1
fi

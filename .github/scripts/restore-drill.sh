#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup-storage.sh
source "${script_dir}/backup-storage.sh"

: "${RESTORE_DRILL_DATABASE_URL:?RESTORE_DRILL_DATABASE_URL is required}"
: "${BACKUP_AGE_IDENTITY:?BACKUP_AGE_IDENTITY is required}"
: "${R2_BACKUP_ENDPOINT:?R2_BACKUP_ENDPOINT is required}"
: "${R2_BACKUP_BUCKET:?R2_BACKUP_BUCKET is required}"

drill_started_epoch="$(date -u +%s)"
drill_dir="$(mktemp -d)"
trap 'rm -rf -- "$drill_dir"' EXIT

requested_key="${RESTORE_BACKUP_KEY:-}"
if [[ -n "$requested_key" ]]; then
  if ! backup_is_restorable_key "$requested_key"; then
    echo "RESTORE_BACKUP_KEY must identify a weekly or manual encrypted backup" >&2
    exit 1
  fi
  selected_record="$(backup_exact_record "$requested_key")"
else
  selected_record="$(backup_latest_record weekly/)"
fi
if [[ -z "$selected_record" ]]; then
  echo "No matching encrypted backup object exists" >&2
  exit 1
fi
IFS=$'\t' read -r latest_key _listed_last_modified _listed_encrypted_size <<< "$selected_record"
if ! backup_is_restorable_key "$latest_key"; then
  echo "Selected backup object has an unexpected key: ${latest_key}" >&2
  exit 1
fi
initial_head="$(backup_head_object_json "$latest_key")"
printf '%s\n' "$initial_head" | backup_validate_head_object_json
initial_identity="$(printf '%s\n' "$initial_head" | backup_head_identity_from_json)"
last_modified="$(printf '%s\n' "$initial_head" | jq --exit-status --raw-output '.LastModified')"
encrypted_size="$(printf '%s\n' "$initial_head" | jq --exit-status --raw-output '.ContentLength')"
object_etag="$(printf '%s\n' "$initial_head" | jq --exit-status --raw-output '.ETag')"
head_encrypted_sha256="$(
  printf '%s\n' "$initial_head" |
    jq --exit-status --raw-output '(.Metadata // {})["encrypted-sha256"] // ""'
)"
backup_age_seconds="$(
  backup_assert_fresh_last_modified \
    "$last_modified" \
    "${RESTORE_MAX_AGE_SECONDS:-691200}"
)"
echo "Restoring ${latest_key}; object age is ${backup_age_seconds} seconds"

encrypted_bundle="${drill_dir}/backup.tar.age"
plain_bundle="${drill_dir}/backup.tar"
restore_dir="${drill_dir}/restored"
identity_file="${drill_dir}/identity.txt"
printf '%s\n' "$BACKUP_AGE_IDENTITY" > "$identity_file"
chmod 600 "$identity_file"

backup_download_object_if_match "$latest_key" "$object_etag" "$encrypted_bundle"
actual_encrypted_size="$(stat --format='%s' "$encrypted_bundle")"
actual_encrypted_sha256="$(sha256sum "$encrypted_bundle" | awk '{print $1}')"
backup_require_sha256 "downloaded encrypted backup SHA-256" "$actual_encrypted_sha256"
if [[ "$actual_encrypted_size" != "$encrypted_size" ]]; then
  echo "Downloaded encrypted archive size does not match R2 HeadObject" >&2
  exit 1
fi
if backup_is_new_key weekly "$latest_key" || backup_is_new_key manual "$latest_key"; then
  backup_require_sha256 "R2 encrypted-sha256 metadata" "$head_encrypted_sha256"
  if [[ "$actual_encrypted_sha256" != "$head_encrypted_sha256" ]]; then
    echo "Downloaded encrypted archive checksum does not match R2 metadata" >&2
    exit 1
  fi
fi
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
if ! backup_validate_manifest_identity "$manifest" "$latest_key"; then
  echo "Backup manifest identity does not match the selected immutable key" >&2
  exit 1
fi
expected_sha256="$(jq --exit-status --raw-output '.dumpSha256' "$manifest")"
actual_sha256="$(sha256sum "$plain_dump" | awk '{print $1}')"
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  echo "Backup dump checksum does not match its encrypted manifest" >&2
  exit 1
fi
manifest_created_at="$(
  jq --exit-status --raw-output '
    .createdAt
    | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
  ' "$manifest"
)"
if ! manifest_created_epoch="$(date --date="$manifest_created_at" +%s 2>/dev/null)"; then
  echo "Backup manifest contains an invalid createdAt timestamp" >&2
  exit 1
fi
last_modified_epoch="$(date --date="$last_modified" +%s)"
if ((manifest_created_epoch > last_modified_epoch + 300)); then
  echo "Backup manifest creation time is later than object LastModified" >&2
  exit 1
fi
backup_assert_fresh_last_modified \
  "$manifest_created_at" \
  "${RESTORE_MAX_AGE_SECONDS:-691200}" > /dev/null

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

verified_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
final_head="$(backup_head_object_json "$latest_key")"
printf '%s\n' "$final_head" | backup_validate_head_object_json
final_identity="$(printf '%s\n' "$final_head" | backup_head_identity_from_json)"
if [[ "$final_identity" != "$initial_identity" ]]; then
  echo "Encrypted backup object changed while the restore drill was running" >&2
  exit 1
fi
verification_marker="${drill_dir}/verification.json"
jq --null-input --compact-output \
  --arg backupKey "$latest_key" \
  --arg verifiedAt "$verified_at" \
  --arg manifestCreatedAt "$manifest_created_at" \
  --arg dumpSha256 "$actual_sha256" \
  --arg encryptedSha256 "$actual_encrypted_sha256" \
  --arg objectEtag "$object_etag" \
  --argjson encryptedSize "$encrypted_size" \
  '{
    formatVersion: 2,
    backupKey: $backupKey,
    verifiedAt: $verifiedAt,
    manifestCreatedAt: $manifestCreatedAt,
    dumpSha256: $dumpSha256,
    encryptedSha256: $encryptedSha256,
    encryptedSize: $encryptedSize,
    objectEtag: $objectEtag
  }' > "$verification_marker"
backup_validate_verification_marker "$verification_marker" "$latest_key"
backup_assert_marker_matches_head "$verification_marker" "$latest_key" "$final_head"
marker_key="$(backup_verification_marker_key "$latest_key")"
maximum_allocation_bytes="${BACKUP_MAX_ALLOCATION_BYTES:-3221225472}"
backup_require_uint "BACKUP_MAX_ALLOCATION_BYTES" "$maximum_allocation_bytes"
allocation_before_marker="$(backup_allocation_bytes)"
existing_marker_record="$(backup_exact_record "$marker_key")"
existing_marker_size=0
existing_marker_etag=""
if [[ -n "$existing_marker_record" ]]; then
  existing_marker_head="$(backup_head_object_json "$marker_key")"
  printf '%s\n' "$existing_marker_head" | backup_validate_head_object_json
  existing_marker_size="$(
    printf '%s\n' "$existing_marker_head" | jq --exit-status --raw-output '.ContentLength'
  )"
  existing_marker_etag="$(
    printf '%s\n' "$existing_marker_head" | jq --exit-status --raw-output '.ETag'
  )"
fi
backup_require_uint "existing verification marker size" "$existing_marker_size"
if ((existing_marker_size > allocation_before_marker)); then
  echo "Verification marker size exceeds the recorded bucket allocation" >&2
  exit 1
fi
marker_size="$(stat --format='%s' "$verification_marker")"
allocation_without_existing_marker=$((allocation_before_marker - existing_marker_size))
backup_assert_projected_allocation \
  "$allocation_without_existing_marker" \
  "$marker_size" \
  "$maximum_allocation_bytes" > /dev/null
marker_put_arguments=(
  --endpoint-url "$R2_BACKUP_ENDPOINT"
  s3api put-object
  --bucket "$R2_BACKUP_BUCKET"
  --key "$marker_key"
  --body "$verification_marker"
  --content-type application/json
  --output json
)
if [[ -n "$existing_marker_etag" ]]; then
  marker_put_arguments+=(--if-match "$existing_marker_etag")
else
  marker_put_arguments+=(--if-none-match '*')
fi
aws "${marker_put_arguments[@]}" > /dev/null

post_marker_head="$(backup_head_object_json "$latest_key")"
printf '%s\n' "$post_marker_head" | backup_validate_head_object_json
post_marker_identity="$(printf '%s\n' "$post_marker_head" | backup_head_identity_from_json)"
if [[ "$post_marker_identity" != "$initial_identity" ]]; then
  echo "Encrypted backup object changed before marker publication completed" >&2
  exit 1
fi
drill_finished_epoch="$(date -u +%s)"
echo "Verified backup ${latest_key} and wrote ${marker_key}; restore drill took $((drill_finished_epoch - drill_started_epoch)) seconds"

#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup-storage.sh
source "${script_dir}/backup-storage.sh"

: "${SUPABASE_PRODUCTION_DB_URL:?SUPABASE_PRODUCTION_DB_URL is required}"
: "${EXPECTED_SUPABASE_PROJECT_REF:?EXPECTED_SUPABASE_PROJECT_REF is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"
: "${R2_BACKUP_ENDPOINT:?R2_BACKUP_ENDPOINT is required}"
: "${R2_BACKUP_BUCKET:?R2_BACKUP_BUCKET is required}"
: "${BACKUP_KIND:?BACKUP_KIND is required}"

case "$BACKUP_KIND" in
  weekly | manual) ;;
  *)
    echo "BACKUP_KIND must be weekly or manual" >&2
    exit 1
    ;;
esac

backup_require_supabase_project_ref \
  "EXPECTED_SUPABASE_PROJECT_REF" \
  "$EXPECTED_SUPABASE_PROJECT_REF"
backup_assert_tls_database_url "$SUPABASE_PRODUCTION_DB_URL"

maximum_allocation_bytes="${BACKUP_MAX_ALLOCATION_BYTES:-3221225472}"
backup_require_uint "BACKUP_MAX_ALLOCATION_BYTES" "$maximum_allocation_bytes"
allocation_before_bytes="$(backup_allocation_bytes)"
backup_assert_projected_allocation "$allocation_before_bytes" 0 "$maximum_allocation_bytes" > /dev/null
echo "Backup allocation preflight: ${allocation_before_bytes} of ${maximum_allocation_bytes} bytes"

database_identity="$(
  psql "$SUPABASE_PRODUCTION_DB_URL" \
    --set ON_ERROR_STOP=1 \
    --no-psqlrc \
    --quiet \
    --tuples-only \
    --no-align \
    --command "
      select identity.environment
        || '/' || identity.supabase_project_ref
        || '/tls=' || connection.ssl::text
      from private.deployment_identity as identity
      cross join pg_catalog.pg_stat_ssl as connection
      where identity.singleton
        and connection.pid = pg_backend_pid()
    "
)"
backup_assert_production_database_identity \
  "$EXPECTED_SUPABASE_PROJECT_REF" \
  "$database_identity"
echo "Production database identity and TLS preflight passed"

backup_dir="$(mktemp -d)"
snapshot_holder_pid=""
snapshot_holder_in=""
snapshot_holder_out=""

cleanup() {
  if [[ -n "${snapshot_holder_in:-}" ]]; then
    printf '%s\n' 'rollback;' '\q' 1>&"$snapshot_holder_in" 2>/dev/null || true
    exec {snapshot_holder_in}>&-
  fi
  if [[ -n "${snapshot_holder_out:-}" ]]; then
    exec {snapshot_holder_out}<&-
  fi
  if [[ -n "${snapshot_holder_pid:-}" ]]; then
    wait "$snapshot_holder_pid" 2>/dev/null || true
  fi
  rm -rf -- "$backup_dir"
}
trap cleanup EXIT

timestamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
backup_key="${BACKUP_KIND}/meoing-${timestamp}.tar.age"
plain_dump="${backup_dir}/meoing.dump"
manifest="${backup_dir}/manifest.json"
plain_bundle="${backup_dir}/meoing-backup.tar"
encrypted_bundle="${plain_bundle}.age"

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

coproc SNAPSHOT_HOLDER {
  psql "$SUPABASE_PRODUCTION_DB_URL" \
    --set ON_ERROR_STOP=1 \
    --no-psqlrc \
    --quiet \
    --tuples-only \
    --no-align
}
# Bash creates NAME_PID for a named coprocess.
# shellcheck disable=SC2153
snapshot_holder_pid="$SNAPSHOT_HOLDER_PID"
snapshot_holder_in="${SNAPSHOT_HOLDER[1]}"
snapshot_holder_out="${SNAPSHOT_HOLDER[0]}"

printf '%s\n' \
  'begin transaction isolation level repeatable read read only;' \
  "select 'MEOING_SNAPSHOT=' || pg_export_snapshot();" \
  >&"$snapshot_holder_in"

snapshot_id=""
while IFS= read -r snapshot_line <&"$snapshot_holder_out"; do
  if [[ "$snapshot_line" == MEOING_SNAPSHOT=* ]]; then
    snapshot_id="${snapshot_line#MEOING_SNAPSHOT=}"
    break
  fi
done
if [[ ! "$snapshot_id" =~ ^[0-9A-Fa-f-]+$ ]]; then
  echo "PostgreSQL returned an invalid exported snapshot identifier" >&2
  exit 1
fi

pg_dump "$SUPABASE_PRODUCTION_DB_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --snapshot="$snapshot_id" \
  --table='app.*' \
  --table=auth.users \
  --table=auth.identities \
  --file="$plain_dump"

count_arguments=()
for relation in "${relations[@]}"; do
  count_arguments+=("'${relation}'" "(select count(*) from ${relation})")
done
printf -v joined_count_arguments '%s,' "${count_arguments[@]}"
count_expression="jsonb_build_object('tables', jsonb_build_object(${joined_count_arguments%,}))"
raw_manifest="${backup_dir}/manifest.raw.json"
printf '%s\n' \
  "select 'MEOING_COUNTS=' || ${count_expression};" \
  >&"$snapshot_holder_in"

manifest_counts=""
while IFS= read -r snapshot_line <&"$snapshot_holder_out"; do
  if [[ "$snapshot_line" == MEOING_COUNTS=* ]]; then
    manifest_counts="${snapshot_line#MEOING_COUNTS=}"
    break
  fi
done
if [[ -z "$manifest_counts" ]]; then
  echo "PostgreSQL did not return snapshot-consistent manifest counts" >&2
  exit 1
fi
printf '%s\n' "$manifest_counts" > "$raw_manifest"

printf '%s\n' 'rollback;' '\q' >&"$snapshot_holder_in"
exec {snapshot_holder_in}>&-
while IFS= read -r _snapshot_holder_line <&"$snapshot_holder_out"; do
  :
done
exec {snapshot_holder_out}<&-
wait "$snapshot_holder_pid"
snapshot_holder_pid=""

dump_sha256="$(sha256sum "$plain_dump" | awk '{print $1}')"
jq --compact-output \
  --arg createdAt "$created_at" \
  --arg backupKey "$backup_key" \
  --arg dumpSha256 "$dump_sha256" \
  '. + {
    formatVersion: 2,
    backupKey: $backupKey,
    createdAt: $createdAt,
    dumpSha256: $dumpSha256
  }' \
  "$raw_manifest" > "$manifest"
jq --exit-status \
  --arg backupKey "$backup_key" \
  '.formatVersion == 2
    and .backupKey == $backupKey
    and (.dumpSha256 | test("^[a-f0-9]{64}$"))
    and (.tables | length == 22)' \
  "$manifest" > /dev/null

tar --create \
  --file "$plain_bundle" \
  --directory "$backup_dir" \
  meoing.dump \
  manifest.json
age --recipient "$BACKUP_AGE_RECIPIENT" --output "$encrypted_bundle" "$plain_bundle"
rm -f -- "$plain_dump" "$manifest" "$raw_manifest" "$plain_bundle"

encrypted_size="$(stat --format='%s' "$encrypted_bundle")"
encrypted_sha256="$(sha256sum "$encrypted_bundle" | awk '{print $1}')"
backup_require_sha256 "encrypted backup SHA-256" "$encrypted_sha256"
projected_allocation_bytes="$(
  backup_assert_projected_allocation \
    "$allocation_before_bytes" \
    "$encrypted_size" \
    "$maximum_allocation_bytes"
)"
echo "Projected backup allocation: ${projected_allocation_bytes} of ${maximum_allocation_bytes} bytes"

aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3api put-object \
  --bucket "$R2_BACKUP_BUCKET" \
  --key "$backup_key" \
  --body "$encrypted_bundle" \
  --content-type application/octet-stream \
  --metadata "encrypted-sha256=${encrypted_sha256}" \
  --if-none-match '*' \
  --output json > /dev/null

uploaded_head="$(backup_head_object_json "$backup_key")"
printf '%s\n' "$uploaded_head" | backup_validate_head_object_json
uploaded_size="$(printf '%s\n' "$uploaded_head" | jq --exit-status --raw-output '.ContentLength')"
uploaded_sha256="$(
  printf '%s\n' "$uploaded_head" |
    jq --exit-status --raw-output '(.Metadata // {})["encrypted-sha256"] // ""'
)"
if [[ "$uploaded_size" != "$encrypted_size" || "$uploaded_sha256" != "$encrypted_sha256" ]]; then
  echo "Uploaded R2 object identity does not match the encrypted archive" >&2
  exit 1
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'backup_key=%s\n' "$backup_key"
    printf 'backup_kind=%s\n' "$BACKUP_KIND"
    printf 'encrypted_sha256=%s\n' "$encrypted_sha256"
    printf 'projected_allocation_bytes=%s\n' "$projected_allocation_bytes"
  } >> "$GITHUB_OUTPUT"
fi
echo "Uploaded encrypted ${BACKUP_KIND} backup ${backup_key}"

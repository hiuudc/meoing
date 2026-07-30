#!/usr/bin/env bash
set -euo pipefail

backup_dir="$(mktemp -d)"
snapshot_holder_pid=""
snapshot_holder_in=""
snapshot_holder_out=""

cleanup() {
  if [[ -n "${snapshot_holder_in:-}" ]]; then
    printf '%s\n' 'rollback;' '\q' >&"$snapshot_holder_in" 2>/dev/null || true
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
daily_key="daily/meoing-${timestamp}.tar.age"
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
  --arg dumpSha256 "$dump_sha256" \
  '. + {formatVersion: 1, createdAt: $createdAt, dumpSha256: $dumpSha256}' \
  "$raw_manifest" > "$manifest"
jq --exit-status \
  '.formatVersion == 1 and (.dumpSha256 | test("^[a-f0-9]{64}$")) and (.tables | length == 22)' \
  "$manifest" > /dev/null

tar --create \
  --file "$plain_bundle" \
  --directory "$backup_dir" \
  meoing.dump \
  manifest.json
age --recipient "$BACKUP_AGE_RECIPIENT" --output "$encrypted_bundle" "$plain_bundle"
rm -f -- "$plain_dump" "$manifest" "$raw_manifest" "$plain_bundle"

aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3 cp \
  "$encrypted_bundle" "s3://${R2_BACKUP_BUCKET}/${daily_key}" \
  --only-show-errors

if [[ "$(date -u +%u)" == "7" ]]; then
  weekly_key="weekly/meoing-$(date -u +%G-W%V).tar.age"
  aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3 cp \
    "$encrypted_bundle" "s3://${R2_BACKUP_BUCKET}/${weekly_key}" \
    --only-show-errors
fi

prune_prefix() {
  local prefix="$1"
  local keep="$2"
  mapfile -t keys < <(
    aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3api list-objects-v2 \
      --bucket "$R2_BACKUP_BUCKET" \
      --prefix "${prefix}/" \
      --query 'Contents[].Key' \
      --output json |
      jq -r '.[]' |
      sort -r
  )
  if ((${#keys[@]} <= keep)); then
    return
  fi
  for key in "${keys[@]:keep}"; do
    aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3 rm \
      "s3://${R2_BACKUP_BUCKET}/${key}" \
      --only-show-errors
  done
}

prune_prefix daily 7
prune_prefix weekly 4

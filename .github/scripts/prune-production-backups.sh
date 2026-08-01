#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup-storage.sh
source "${script_dir}/backup-storage.sh"

: "${R2_BACKUP_ENDPOINT:?R2_BACKUP_ENDPOINT is required}"
: "${R2_BACKUP_BUCKET:?R2_BACKUP_BUCKET is required}"
: "${VERIFIED_BACKUP_KEY:?VERIFIED_BACKUP_KEY is required}"

keep="${WEEKLY_BACKUP_KEEP_COUNT:-4}"
backup_require_uint "WEEKLY_BACKUP_KEEP_COUNT" "$keep"
if ((keep < 1)); then
  echo "WEEKLY_BACKUP_KEEP_COUNT must be at least 1" >&2
  exit 1
fi
if ! backup_is_new_key weekly "$VERIFIED_BACKUP_KEY"; then
  echo "Retention requires the newly restored immutable weekly backup key" >&2
  exit 1
fi

prune_dir="$(mktemp -d)"
trap 'rm -rf -- "$prune_dir"' EXIT

weekly_inventory="$(backup_list_objects_json weekly/)"
marker_inventory="$(backup_list_objects_json verified/weekly/)"
printf '%s\n' "$weekly_inventory" | backup_validate_inventory_records
printf '%s\n' "$marker_inventory" | backup_validate_inventory_records

mapfile -t weekly_records < <(
  printf '%s\n' "$weekly_inventory" |
    jq --raw-output '(.Contents // []) | sort_by(.LastModified, .Key)[] | [.Key, .LastModified, (.Size | tostring)] | @tsv'
)
for record in "${weekly_records[@]}"; do
  IFS=$'\t' read -r key _last_modified _size <<< "$record"
  if ! backup_is_new_key weekly "$key" && ! backup_is_legacy_weekly_key "$key"; then
    echo "Unexpected object under weekly/: ${key}; refusing to prune" >&2
    exit 1
  fi
done

mapfile -t marker_keys < <(
  printf '%s\n' "$marker_inventory" |
    jq --raw-output '(.Contents // [])[].Key' |
    tr -d '\r'
)
for marker_key in "${marker_keys[@]}"; do
  marked_backup_key="${marker_key#verified/}"
  marked_backup_key="${marked_backup_key%.json}"
  if [[ "$marker_key" != "$(backup_verification_marker_key "$marked_backup_key")" ]] \
    || { ! backup_is_new_key weekly "$marked_backup_key" && ! backup_is_legacy_weekly_key "$marked_backup_key"; }; then
    echo "Unexpected object under verified/weekly/: ${marker_key}; refusing to prune" >&2
    exit 1
  fi
done

verified_records=()
declare -A verified_backup_identities=()
declare -A verified_marker_identities=()
current_verified=0
record_index=0
for record in "${weekly_records[@]}"; do
  IFS=$'\t' read -r key last_modified size <<< "$record"
  marker_key="$(backup_verification_marker_key "$key")"
  marker_record="$(printf '%s\n' "$marker_inventory" | backup_exact_record_from_json "$marker_key")"
  if [[ -z "$marker_record" ]]; then
    echo "Leaving unverified weekly backup outside retention slots: ${key}"
    record_index=$((record_index + 1))
    continue
  fi

  marker_file="${prune_dir}/marker-${record_index}.json"
  backup_head="$(backup_head_object_json "$key")"
  marker_head="$(backup_head_object_json "$marker_key")"
  printf '%s\n' "$backup_head" | backup_validate_head_object_json
  printf '%s\n' "$marker_head" | backup_validate_head_object_json
  marker_etag="$(printf '%s\n' "$marker_head" | jq --exit-status --raw-output '.ETag')"
  backup_download_object_if_match "$marker_key" "$marker_etag" "$marker_file"
  if ! backup_validate_verification_marker "$marker_file" "$key"; then
    echo "Weekly verification marker is invalid for ${key}; refusing to prune" >&2
    exit 1
  fi
  if ! backup_assert_marker_matches_head "$marker_file" "$key" "$backup_head"; then
    echo "Weekly verification marker does not match the current object: ${key}" >&2
    exit 1
  fi
  verified_records+=("$record")
  verified_backup_identities["$key"]="$(printf '%s\n' "$backup_head" | backup_head_identity_from_json)"
  verified_marker_identities["$key"]="$(printf '%s\n' "$marker_head" | backup_head_identity_from_json)"
  if [[ "$key" == "$VERIFIED_BACKUP_KEY" ]]; then
    current_verified=1
    current_backup_last_modified="$(
      printf '%s\n' "$backup_head" | jq --exit-status --raw-output '.LastModified'
    )"
    current_marker_last_modified="$(
      printf '%s\n' "$marker_head" | jq --exit-status --raw-output '.LastModified'
    )"
    backup_assert_fresh_last_modified \
      "$current_backup_last_modified" \
      "${RESTORE_MAX_AGE_SECONDS:-691200}" > /dev/null
    backup_assert_fresh_last_modified \
      "$current_marker_last_modified" \
      "${RESTORE_MAX_AGE_SECONDS:-691200}" > /dev/null
    manifest_created_at="$(jq --exit-status --raw-output '.manifestCreatedAt' "$marker_file")"
    backup_assert_fresh_last_modified \
      "$manifest_created_at" \
      "${RESTORE_MAX_AGE_SECONDS:-691200}" > /dev/null
    verified_at="$(jq --exit-status --raw-output '.verifiedAt' "$marker_file")"
    backup_assert_fresh_last_modified \
      "$verified_at" \
      "${RESTORE_MAX_AGE_SECONDS:-691200}" > /dev/null
  fi
  record_index=$((record_index + 1))
done

if ((current_verified != 1)); then
  echo "The just-restored weekly backup has no valid matching marker; refusing to prune" >&2
  exit 1
fi

verified_count="${#verified_records[@]}"
if ((verified_count <= keep)); then
  echo "Verified weekly retention already satisfies the ${keep}-object limit; unverified objects were untouched"
  exit 0
fi

delete_count=$((verified_count - keep))
candidates=("${verified_records[@]:0:delete_count}")
for candidate in "${candidates[@]}"; do
  IFS=$'\t' read -r key _last_modified _size <<< "$candidate"
  if [[ "$key" == "$VERIFIED_BACKUP_KEY" ]]; then
    echo "LastModified ordering selected the just-verified backup for deletion; refusing to prune" >&2
    exit 1
  fi
done

for record in "${verified_records[@]}"; do
  IFS=$'\t' read -r key _last_modified _size <<< "$record"
  marker_key="$(backup_verification_marker_key "$key")"
  current_backup_identity="$(
    backup_head_object_json "$key" | backup_head_identity_from_json
  )"
  current_marker_identity="$(
    backup_head_object_json "$marker_key" | backup_head_identity_from_json
  )"
  if [[ "$current_backup_identity" != "${verified_backup_identities[$key]}" ]] \
    || [[ "$current_marker_identity" != "${verified_marker_identities[$key]}" ]]; then
    echo "Verified weekly object or marker changed before retention: ${key}" >&2
    exit 1
  fi
done

for candidate in "${candidates[@]}"; do
  IFS=$'\t' read -r key last_modified size <<< "$candidate"
  echo "Pruning verified weekly backup ${key} (${size} bytes, LastModified ${last_modified})"
  aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3 rm \
    "s3://${R2_BACKUP_BUCKET}/${key}" \
    --only-show-errors
  old_marker_key="$(backup_verification_marker_key "$key")"
  aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3 rm \
    "s3://${R2_BACKUP_BUCKET}/${old_marker_key}" \
    --only-show-errors
done

#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup-storage.sh
source "${script_dir}/backup-storage.sh"

: "${R2_BACKUP_ENDPOINT:?R2_BACKUP_ENDPOINT is required}"
: "${R2_BACKUP_BUCKET:?R2_BACKUP_BUCKET is required}"

mode="${LEGACY_CLEANUP_MODE:-preview}"
case "$mode" in
  preview | delete) ;;
  *)
    echo "LEGACY_CLEANUP_MODE must be preview or delete" >&2
    exit 1
    ;;
esac

daily_inventory="$(backup_list_objects_json daily/)"
printf '%s\n' "$daily_inventory" | backup_validate_inventory_records
mapfile -t daily_records < <(
  printf '%s\n' "$daily_inventory" |
    jq --raw-output '(.Contents // []) | sort_by(.LastModified, .Key)[] | [.Key, .LastModified, (.Size | tostring)] | @tsv'
)
for record in "${daily_records[@]}"; do
  IFS=$'\t' read -r key _last_modified _size <<< "$record"
  if ! backup_is_legacy_daily_key "$key"; then
    echo "Unexpected object under daily/: ${key}; refusing legacy cleanup" >&2
    exit 1
  fi
done

daily_count="${#daily_records[@]}"
daily_bytes="$(printf '%s\n' "$daily_inventory" | backup_inventory_bytes_from_json)"
daily_digest="$(printf '%s\n' "$daily_inventory" | backup_inventory_digest_from_json)"
backup_require_sha256 "legacy daily inventory digest" "$daily_digest"
echo "Legacy daily cleanup ${mode}: ${daily_count} objects, ${daily_bytes} bytes, inventory ${daily_digest}"
for record in "${daily_records[@]}"; do
  IFS=$'\t' read -r key last_modified size <<< "$record"
  echo "  ${key} (${size} bytes, LastModified ${last_modified})"
done

if [[ "$mode" == "preview" ]]; then
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    {
      printf 'object_count=%s\n' "$daily_count"
      printf 'inventory_digest=%s\n' "$daily_digest"
    } >> "$GITHUB_OUTPUT"
  fi
  echo "Preview only; no legacy objects were deleted"
  exit 0
fi

expected_count="${LEGACY_DAILY_EXPECTED_COUNT:?LEGACY_DAILY_EXPECTED_COUNT is required for delete mode}"
expected_digest="${LEGACY_DAILY_EXPECTED_DIGEST:?LEGACY_DAILY_EXPECTED_DIGEST is required for delete mode}"
backup_require_uint "LEGACY_DAILY_EXPECTED_COUNT" "$expected_count"
backup_require_sha256 "LEGACY_DAILY_EXPECTED_DIGEST" "$expected_digest"
if ((expected_count != daily_count)); then
  echo "Expected ${expected_count} legacy daily objects but found ${daily_count}; refusing cleanup" >&2
  exit 1
fi
if [[ "$expected_digest" != "$daily_digest" ]]; then
  echo "Legacy daily inventory digest changed since preview; refusing cleanup" >&2
  exit 1
fi
if [[ "${LEGACY_DAILY_CLEANUP_CONFIRMATION:-}" != "DELETE LEGACY DAILY BACKUPS" ]]; then
  echo "Legacy cleanup confirmation did not match; refusing cleanup" >&2
  exit 1
fi

latest_marker_record="$(backup_latest_record verified/weekly/)"
if [[ -z "$latest_marker_record" ]]; then
  echo "No verified weekly backup marker exists; refusing legacy cleanup" >&2
  exit 1
fi
IFS=$'\t' read -r marker_key _marker_listed_last_modified _marker_size <<< "$latest_marker_record"
verified_backup_key="${marker_key#verified/}"
verified_backup_key="${verified_backup_key%.json}"
if ! backup_is_new_key weekly "$verified_backup_key"; then
  echo "The latest marker does not identify a new immutable weekly backup; refusing legacy cleanup" >&2
  exit 1
fi
cleanup_dir="$(mktemp -d)"
trap 'rm -rf -- "$cleanup_dir"' EXIT
marker_file="${cleanup_dir}/verification.json"
marker_head="$(backup_head_object_json "$marker_key")"
printf '%s\n' "$marker_head" | backup_validate_head_object_json
marker_identity="$(printf '%s\n' "$marker_head" | backup_head_identity_from_json)"
marker_last_modified="$(printf '%s\n' "$marker_head" | jq --exit-status --raw-output '.LastModified')"
marker_etag="$(printf '%s\n' "$marker_head" | jq --exit-status --raw-output '.ETag')"
backup_assert_fresh_last_modified "$marker_last_modified" "${RESTORE_MAX_AGE_SECONDS:-691200}" > /dev/null
backup_download_object_if_match "$marker_key" "$marker_etag" "$marker_file"
backup_validate_verification_marker "$marker_file" "$verified_backup_key"
manifest_created_at="$(jq --exit-status --raw-output '.manifestCreatedAt' "$marker_file")"
backup_assert_fresh_last_modified \
  "$manifest_created_at" \
  "${RESTORE_MAX_AGE_SECONDS:-691200}" > /dev/null
verified_at="$(jq --exit-status --raw-output '.verifiedAt' "$marker_file")"
backup_assert_fresh_last_modified \
  "$verified_at" \
  "${RESTORE_MAX_AGE_SECONDS:-691200}" > /dev/null

verified_record="$(backup_exact_record "$verified_backup_key")"
if [[ -z "$verified_record" ]]; then
  echo "The verified weekly backup object no longer exists; refusing legacy cleanup" >&2
  exit 1
fi
verified_head="$(backup_head_object_json "$verified_backup_key")"
printf '%s\n' "$verified_head" | backup_validate_head_object_json
verified_identity="$(printf '%s\n' "$verified_head" | backup_head_identity_from_json)"
verified_last_modified="$(printf '%s\n' "$verified_head" | jq --exit-status --raw-output '.LastModified')"
backup_assert_fresh_last_modified "$verified_last_modified" "${RESTORE_MAX_AGE_SECONDS:-691200}" > /dev/null
backup_assert_marker_matches_head "$marker_file" "$verified_backup_key" "$verified_head"

final_daily_inventory="$(backup_list_objects_json daily/)"
printf '%s\n' "$final_daily_inventory" | backup_validate_inventory_records
final_daily_digest="$(printf '%s\n' "$final_daily_inventory" | backup_inventory_digest_from_json)"
if [[ "$final_daily_digest" != "$daily_digest" ]]; then
  echo "Legacy daily inventory changed during safety validation; refusing cleanup" >&2
  exit 1
fi
if [[ "$(backup_head_object_json "$verified_backup_key" | backup_head_identity_from_json)" != "$verified_identity" ]] \
  || [[ "$(backup_head_object_json "$marker_key" | backup_head_identity_from_json)" != "$marker_identity" ]]; then
  echo "Verified weekly backup or marker changed before legacy cleanup" >&2
  exit 1
fi

for record in "${daily_records[@]}"; do
  IFS=$'\t' read -r key _last_modified _size <<< "$record"
  aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3 rm \
    "s3://${R2_BACKUP_BUCKET}/${key}" \
    --only-show-errors
  old_marker_key="$(backup_verification_marker_key "$key")"
  aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3 rm \
    "s3://${R2_BACKUP_BUCKET}/${old_marker_key}" \
    --only-show-errors
done
echo "Deleted ${daily_count} verified-safe legacy daily backup objects"

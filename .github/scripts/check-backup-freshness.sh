#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup-storage.sh
source "${script_dir}/backup-storage.sh"

: "${R2_BACKUP_ENDPOINT:?R2_BACKUP_ENDPOINT is required}"
: "${R2_BACKUP_BUCKET:?R2_BACKUP_BUCKET is required}"

maximum_age_seconds="${RESTORE_MAX_AGE_SECONDS:-691200}"
latest_record="$(backup_latest_record weekly/)"
if [[ -z "$latest_record" ]]; then
  echo "No weekly backup object exists" >&2
  exit 1
fi
IFS=$'\t' read -r latest_key _listed_last_modified _listed_size <<< "$latest_record"
if ! backup_is_new_key weekly "$latest_key" && ! backup_is_legacy_weekly_key "$latest_key"; then
  echo "Latest weekly object has an unexpected key: ${latest_key}" >&2
  exit 1
fi
backup_head="$(backup_head_object_json "$latest_key")"
printf '%s\n' "$backup_head" | backup_validate_head_object_json
backup_identity="$(printf '%s\n' "$backup_head" | backup_head_identity_from_json)"
last_modified="$(printf '%s\n' "$backup_head" | jq --exit-status --raw-output '.LastModified')"
object_age_seconds="$(backup_assert_fresh_last_modified "$last_modified" "$maximum_age_seconds")"

marker_key="$(backup_verification_marker_key "$latest_key")"
marker_record="$(backup_exact_record "$marker_key")"
if [[ -z "$marker_record" ]]; then
  echo "Latest weekly backup has no restore verification marker: ${latest_key}" >&2
  exit 1
fi
marker_head="$(backup_head_object_json "$marker_key")"
printf '%s\n' "$marker_head" | backup_validate_head_object_json
marker_identity="$(printf '%s\n' "$marker_head" | backup_head_identity_from_json)"
marker_last_modified="$(printf '%s\n' "$marker_head" | jq --exit-status --raw-output '.LastModified')"
marker_etag="$(printf '%s\n' "$marker_head" | jq --exit-status --raw-output '.ETag')"
marker_age_seconds="$(backup_assert_fresh_last_modified "$marker_last_modified" "$maximum_age_seconds")"

check_dir="$(mktemp -d)"
trap 'rm -rf -- "$check_dir"' EXIT
marker_file="${check_dir}/verification.json"
backup_download_object_if_match "$marker_key" "$marker_etag" "$marker_file"
backup_validate_verification_marker "$marker_file" "$latest_key"
backup_assert_marker_matches_head "$marker_file" "$latest_key" "$backup_head"
manifest_created_at="$(jq --exit-status --raw-output '.manifestCreatedAt' "$marker_file")"
manifest_age_seconds="$(
  backup_assert_fresh_last_modified "$manifest_created_at" "$maximum_age_seconds"
)"
verified_at="$(jq --exit-status --raw-output '.verifiedAt' "$marker_file")"
verification_age_seconds="$(backup_assert_fresh_last_modified "$verified_at" "$maximum_age_seconds")"

final_backup_head="$(backup_head_object_json "$latest_key")"
final_marker_head="$(backup_head_object_json "$marker_key")"
printf '%s\n' "$final_backup_head" | backup_validate_head_object_json
printf '%s\n' "$final_marker_head" | backup_validate_head_object_json
if [[ "$(printf '%s\n' "$final_backup_head" | backup_head_identity_from_json)" != "$backup_identity" ]] \
  || [[ "$(printf '%s\n' "$final_marker_head" | backup_head_identity_from_json)" != "$marker_identity" ]]; then
  echo "Backup or verification marker changed during freshness validation" >&2
  exit 1
fi

echo "Backup freshness healthy: ${latest_key}; object=${object_age_seconds}s marker=${marker_age_seconds}s verification=${verification_age_seconds}s recovery-point=${manifest_age_seconds}s"

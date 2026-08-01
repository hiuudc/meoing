#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup-storage.sh
source "${script_dir}/backup-storage.sh"

: "${R2_BACKUP_ENDPOINT:?R2_BACKUP_ENDPOINT is required}"
: "${R2_BACKUP_BUCKET:?R2_BACKUP_BUCKET is required}"

mode="${BACKUP_CLEANUP_MODE:-preview}"
scope="${BACKUP_CLEANUP_SCOPE:-manual}"
minimum_age_seconds="${BACKUP_CLEANUP_MINIMUM_AGE_SECONDS:-691200}"

case "$mode" in
  preview | delete) ;;
  *)
    echo "BACKUP_CLEANUP_MODE must be preview or delete" >&2
    exit 1
    ;;
esac
case "$scope" in
  manual | unverified-weekly) ;;
  *)
    echo "BACKUP_CLEANUP_SCOPE must be manual or unverified-weekly" >&2
    exit 1
    ;;
esac
backup_require_uint "BACKUP_CLEANUP_MINIMUM_AGE_SECONDS" "$minimum_age_seconds"
if ((minimum_age_seconds < 691200)); then
  echo "Unretained backups must be at least eight days old before cleanup" >&2
  exit 1
fi

candidate_records=()
candidate_bytes=0
cleanup_dir="$(mktemp -d)"
trap 'rm -rf -- "$cleanup_dir"' EXIT

load_candidates() {
  candidate_records=()
  candidate_bytes=0

  local inventory
  local marker_inventory
  local prefix
  local marker_prefix
  if [[ "$scope" == "manual" ]]; then
    prefix="manual/"
    marker_prefix="verified/manual/"
  else
    prefix="weekly/"
    marker_prefix="verified/weekly/"
  fi

  inventory="$(backup_list_objects_json "$prefix")"
  marker_inventory="$(backup_list_objects_json "$marker_prefix")"
  printf '%s\n' "$inventory" | backup_validate_inventory_records
  printf '%s\n' "$marker_inventory" | backup_validate_inventory_records

  local records=()
  mapfile -t records < <(
    printf '%s\n' "$inventory" |
      jq --raw-output '
        (.Contents // [])
        | sort_by(.LastModified, .Key)[]
        | [.Key, .LastModified, (.Size | tostring), (.ETag // "")]
        | @tsv
      ' |
      tr -d '\r'
  )

  local record
  local record_index=0
  for record in "${records[@]}"; do
    local key
    local listed_last_modified
    local listed_size
    local listed_etag
    IFS=$'\t' read -r key listed_last_modified listed_size listed_etag <<< "$record"
    backup_require_uint "backup object size" "$listed_size"

    if [[ "$scope" == "manual" ]]; then
      if ! backup_is_new_key manual "$key"; then
        echo "Unexpected object under manual/: ${key}; refusing cleanup" >&2
        return 1
      fi
    else
      if ! backup_is_new_key weekly "$key" && ! backup_is_legacy_weekly_key "$key"; then
        echo "Unexpected object under weekly/: ${key}; refusing cleanup" >&2
        return 1
      fi
    fi

    local backup_head
    local backup_identity
    local last_modified
    local size
    local etag
    backup_head="$(backup_head_object_json "$key")" || return 1
    printf '%s\n' "$backup_head" | backup_validate_head_object_json
    backup_identity="$(printf '%s\n' "$backup_head" | backup_head_identity_from_json)"
    last_modified="$(printf '%s\n' "$backup_head" | jq --exit-status --raw-output '.LastModified')"
    size="$(printf '%s\n' "$backup_head" | jq --exit-status --raw-output '.ContentLength')"
    etag="$(printf '%s\n' "$backup_head" | jq --exit-status --raw-output '.ETag')"
    if [[ "$last_modified" != "$listed_last_modified" || "$size" != "$listed_size" ]] \
      || { [[ -n "$listed_etag" ]] && [[ "$etag" != "$listed_etag" ]]; }; then
      echo "Backup object changed while cleanup inventory was being built: ${key}" >&2
      return 1
    fi

    local age_seconds
    age_seconds="$(backup_object_age_seconds "$last_modified")" || return 1
    if ((age_seconds < minimum_age_seconds)); then
      continue
    fi

    local marker_key
    local marker_record
    local marker_identity="null"
    marker_key="$(backup_verification_marker_key "$key")"
    marker_record="$(printf '%s\n' "$marker_inventory" | backup_exact_record_from_json "$marker_key")"
    if [[ -n "$marker_record" ]]; then
      local marker_listed_last_modified
      local marker_listed_size
      IFS=$'\t' read -r _marker_key marker_listed_last_modified marker_listed_size <<< "$marker_record"

      local marker_head
      local marker_last_modified
      local marker_size
      local marker_etag
      marker_head="$(backup_head_object_json "$marker_key")" || return 1
      printf '%s\n' "$marker_head" | backup_validate_head_object_json
      marker_identity="$(printf '%s\n' "$marker_head" | backup_head_identity_from_json)"
      marker_last_modified="$(printf '%s\n' "$marker_head" | jq --exit-status --raw-output '.LastModified')"
      marker_size="$(printf '%s\n' "$marker_head" | jq --exit-status --raw-output '.ContentLength')"
      marker_etag="$(printf '%s\n' "$marker_head" | jq --exit-status --raw-output '.ETag')"
      if [[ "$marker_last_modified" != "$marker_listed_last_modified" || "$marker_size" != "$marker_listed_size" ]]; then
        echo "Verification marker changed while cleanup inventory was being built: ${marker_key}" >&2
        return 1
      fi

      local marker_file="${cleanup_dir}/marker-${record_index}.json"
      backup_download_object_if_match "$marker_key" "$marker_etag" "$marker_file" || return 1
      if [[ "$scope" == "unverified-weekly" ]] \
        && backup_validate_verification_marker "$marker_file" "$key" > /dev/null 2>&1 \
        && backup_assert_marker_matches_head "$marker_file" "$key" "$backup_head" > /dev/null 2>&1; then
        record_index=$((record_index + 1))
        continue
      fi
    fi

    local candidate_record
    candidate_record="$(
      jq --null-input --compact-output --sort-keys \
        --arg key "$key" \
        --arg markerKey "$marker_key" \
        --argjson backupIdentity "$backup_identity" \
        --argjson markerIdentity "$marker_identity" \
        '{
          backupIdentity: $backupIdentity,
          key: $key,
          markerIdentity: $markerIdentity,
          markerKey: $markerKey
        }'
    )" || return 1
    candidate_records+=("$candidate_record")
    candidate_bytes=$((candidate_bytes + size))
    record_index=$((record_index + 1))
  done
}

load_candidates
candidate_count="${#candidate_records[@]}"
candidate_digest="$(backup_records_digest "${candidate_records[@]}")"
backup_require_sha256 "unretained backup inventory digest" "$candidate_digest"

echo "Unretained backup cleanup ${mode}/${scope}: ${candidate_count} objects, ${candidate_bytes} bytes, inventory ${candidate_digest}"
for record in "${candidate_records[@]}"; do
  key="$(printf '%s\n' "$record" | jq --exit-status --raw-output '.key')"
  last_modified="$(printf '%s\n' "$record" | jq --exit-status --raw-output '.backupIdentity.lastModified')"
  size="$(printf '%s\n' "$record" | jq --exit-status --raw-output '.backupIdentity.contentLength')"
  echo "  ${key} (${size} bytes, LastModified ${last_modified})"
done

if [[ "$mode" == "preview" ]]; then
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    {
      printf 'object_count=%s\n' "$candidate_count"
      printf 'inventory_digest=%s\n' "$candidate_digest"
    } >> "$GITHUB_OUTPUT"
  fi
  echo "Preview only; no unretained backup was deleted"
  exit 0
fi

expected_count="${BACKUP_CLEANUP_EXPECTED_COUNT:?BACKUP_CLEANUP_EXPECTED_COUNT is required for delete mode}"
expected_digest="${BACKUP_CLEANUP_EXPECTED_DIGEST:?BACKUP_CLEANUP_EXPECTED_DIGEST is required for delete mode}"
backup_require_uint "BACKUP_CLEANUP_EXPECTED_COUNT" "$expected_count"
backup_require_sha256 "BACKUP_CLEANUP_EXPECTED_DIGEST" "$expected_digest"
if ((expected_count != candidate_count)); then
  echo "Expected ${expected_count} cleanup candidates but found ${candidate_count}; refusing cleanup" >&2
  exit 1
fi
if [[ "$expected_digest" != "$candidate_digest" ]]; then
  echo "Cleanup candidate inventory changed since preview; refusing cleanup" >&2
  exit 1
fi
if [[ "${BACKUP_CLEANUP_CONFIRMATION:-}" != "DELETE UNRETAINED BACKUPS" ]]; then
  echo "Unretained backup cleanup confirmation did not match; refusing cleanup" >&2
  exit 1
fi

load_candidates
final_count="${#candidate_records[@]}"
final_digest="$(backup_records_digest "${candidate_records[@]}")"
if ((final_count != expected_count)) || [[ "$final_digest" != "$expected_digest" ]]; then
  echo "Cleanup candidate inventory changed during validation; refusing cleanup" >&2
  exit 1
fi

for record in "${candidate_records[@]}"; do
  key="$(printf '%s\n' "$record" | jq --exit-status --raw-output '.key')"
  marker_key="$(printf '%s\n' "$record" | jq --exit-status --raw-output '.markerKey')"
  approved_backup_identity="$(
    printf '%s\n' "$record" | jq --exit-status --compact-output --sort-keys '.backupIdentity'
  )"
  approved_marker_identity="$(
    printf '%s\n' "$record" | jq --compact-output --sort-keys '.markerIdentity'
  )"
  current_backup_identity="$(
    backup_head_object_json "$key" | backup_head_identity_from_json
  )"
  if [[ "$current_backup_identity" != "$approved_backup_identity" ]]; then
    echo "Cleanup candidate changed before deletion: ${key}" >&2
    exit 1
  fi

  current_marker_record="$(backup_exact_record "$marker_key")"
  if [[ "$approved_marker_identity" == "null" ]]; then
    if [[ -n "$current_marker_record" ]]; then
      echo "A verification marker appeared for ${key}; refusing cleanup" >&2
      exit 1
    fi
  else
    if [[ -z "$current_marker_record" ]]; then
      echo "The approved marker disappeared before cleanup: ${marker_key}" >&2
      exit 1
    fi
    current_marker_identity="$(
      backup_head_object_json "$marker_key" | backup_head_identity_from_json
    )"
    if [[ "$current_marker_identity" != "$approved_marker_identity" ]]; then
      echo "Verification marker changed before cleanup: ${marker_key}" >&2
      exit 1
    fi
  fi
done

for record in "${candidate_records[@]}"; do
  key="$(printf '%s\n' "$record" | jq --exit-status --raw-output '.key')"
  marker_key="$(printf '%s\n' "$record" | jq --exit-status --raw-output '.markerKey')"
  marker_present="$(printf '%s\n' "$record" | jq --raw-output '.markerIdentity != null')"
  aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3 rm \
    "s3://${R2_BACKUP_BUCKET}/${key}" \
    --only-show-errors
  if [[ "$marker_present" == "true" ]]; then
    aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3 rm \
      "s3://${R2_BACKUP_BUCKET}/${marker_key}" \
      --only-show-errors
  fi
done

echo "Deleted ${candidate_count} ${scope} backup objects selected by the exact approved inventory"

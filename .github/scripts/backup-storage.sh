#!/usr/bin/env bash

# Shared, side-effect-free helpers for production backup storage operations.
# Callers are expected to enable `set -euo pipefail`.

backup_require_uint() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "${name} must be an unsigned integer" >&2
    return 1
  fi
}

backup_require_sha256() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[a-f0-9]{64}$ ]]; then
    echo "${name} must be a lowercase SHA-256 digest" >&2
    return 1
  fi
}

backup_require_supabase_project_ref() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[a-z0-9]{20}$ ]]; then
    echo "${name} must be a 20-character lowercase Supabase project ref" >&2
    return 1
  fi
}

backup_assert_tls_database_url() {
  local database_url="$1"
  case "$database_url" in
    postgres://* | postgresql://*) ;;
    *)
      echo "SUPABASE_PRODUCTION_DB_URL must be a PostgreSQL URL" >&2
      return 1
      ;;
  esac

  local query_string="${database_url#*\?}"
  if [[ "$query_string" == "$database_url" ]]; then
    echo "SUPABASE_PRODUCTION_DB_URL must explicitly set sslmode=require or sslmode=verify-full" >&2
    return 1
  fi

  local sslmode=""
  local sslmode_count=0
  local parameter
  local -a parameters=()
  IFS='&' read -r -a parameters <<< "$query_string"
  for parameter in "${parameters[@]}"; do
    if [[ "${parameter%%=*}" == "sslmode" ]]; then
      sslmode="${parameter#*=}"
      sslmode_count=$((sslmode_count + 1))
    fi
  done

  if [[ "$sslmode_count" -ne 1 || ( "$sslmode" != "require" && "$sslmode" != "verify-full" ) ]]; then
    echo "SUPABASE_PRODUCTION_DB_URL must explicitly set exactly one sslmode=require or sslmode=verify-full" >&2
    return 1
  fi
}

backup_assert_production_database_identity() {
  local expected_project_ref="$1"
  local actual_identity="$2"
  local expected_identity="production/${expected_project_ref}/tls=true"
  if [[ "$actual_identity" != "$expected_identity" ]]; then
    echo "SUPABASE_PRODUCTION_DB_URL does not match the pinned production database identity with TLS" >&2
    return 1
  fi
}

backup_list_objects_json() {
  local prefix="$1"
  local continuation_token=""
  local inventory='{"Contents":[]}'
  local page_count=0
  declare -A seen_tokens=()

  while :; do
    local arguments=(
      --endpoint-url "$R2_BACKUP_ENDPOINT"
      s3api list-objects-v2
      --bucket "$R2_BACKUP_BUCKET"
      --no-paginate
    )
    if [[ -n "$prefix" ]]; then
      arguments+=(--prefix "$prefix")
    fi
    if [[ -n "$continuation_token" ]]; then
      arguments+=(--continuation-token "$continuation_token")
    fi
    arguments+=(--output json)

    local page
    page="$(aws "${arguments[@]}")" || return 1
    if ! printf '%s\n' "$page" | jq --exit-status '
        (.Contents // [] | type) == "array"
        and ((.IsTruncated // false) | type) == "boolean"
        and (
          if (.IsTruncated // false) then
            (.NextContinuationToken | type) == "string"
            and (.NextContinuationToken | length) > 0
          else
            true
          end
        )
      ' > /dev/null; then
      echo "Backup inventory page has an invalid pagination contract" >&2
      return 1
    fi
    printf '%s\n' "$page" | backup_validate_inventory_records || return 1
    inventory="$({
      printf '%s\n' "$inventory"
      printf '%s\n' "$page"
    } | jq --slurp --compact-output '{Contents: (map(.Contents // []) | add)}')" || return 1

    if [[ "$(printf '%s\n' "$page" | jq --raw-output '.IsTruncated // false')" != "true" ]]; then
      break
    fi
    continuation_token="$(
      printf '%s\n' "$page" |
        jq --exit-status --raw-output '.NextContinuationToken | select(type == "string" and length > 0)'
    )" || return 1
    if [[ -n "${seen_tokens[$continuation_token]:-}" ]]; then
      echo "Backup inventory pagination repeated a continuation token" >&2
      return 1
    fi
    seen_tokens["$continuation_token"]=1
    page_count=$((page_count + 1))
    if ((page_count > 10000)); then
      echo "Backup inventory exceeded the pagination safety limit" >&2
      return 1
    fi
  done

  printf '%s\n' "$inventory"
}

backup_inventory_bytes_from_json() {
  jq --exit-status --raw-output '
    [(.Contents // [])[] | .Size] as $sizes
    | if all($sizes[]; type == "number" and . >= 0 and floor == .) then
        ($sizes | add // 0)
      else
        error("backup inventory contains an invalid object size")
      end
  '
}

backup_inventory_count_from_json() {
  jq --exit-status --raw-output '(.Contents // []) | length'
}

backup_allocation_bytes() {
  local inventory
  local total
  inventory="$(backup_list_objects_json "")" || return 1
  printf '%s\n' "$inventory" | backup_validate_inventory_records || return 1
  total="$(printf '%s\n' "$inventory" | backup_inventory_bytes_from_json)" || return 1
  backup_require_uint "backup bucket allocation" "$total" || return 1
  printf '%s\n' "$total"
}

backup_inventory_digest_from_json() {
  local canonical_inventory
  canonical_inventory="$({
    jq --compact-output --sort-keys '
      [(.Contents // [])[] | {Key, LastModified, Size, ETag: (.ETag // "")}]
      | sort_by(.Key, .LastModified, .Size, .ETag)
    '
  })" || return 1
  printf 'meoing-backup-inventory-v1\n%s' "$canonical_inventory" |
    sha256sum |
    awk '{print $1}'
}

backup_records_digest() {
  {
    printf '%s\n' 'meoing-backup-records-v1'
    if (($# > 0)); then
      printf '%s\n' "$@" | LC_ALL=C sort
    fi
  } | sha256sum | awk '{print $1}'
}

backup_assert_projected_allocation() {
  local current_bytes="$1"
  local new_bytes="$2"
  local maximum_bytes="$3"
  backup_require_uint "current backup allocation" "$current_bytes" || return 1
  backup_require_uint "new archive size" "$new_bytes" || return 1
  backup_require_uint "maximum backup allocation" "$maximum_bytes" || return 1

  local projected_bytes=$((current_bytes + new_bytes))
  if ((current_bytes > maximum_bytes)); then
    echo "Backup allocation is already ${current_bytes} bytes, above the ${maximum_bytes}-byte limit" >&2
    return 1
  fi
  if ((projected_bytes > maximum_bytes)); then
    echo "Projected backup allocation is ${projected_bytes} bytes, above the ${maximum_bytes}-byte limit" >&2
    return 1
  fi
  printf '%s\n' "$projected_bytes"
}

backup_latest_record_from_json() {
  local prefix="$1"
  jq --raw-output --arg prefix "$prefix" '
    [
      (.Contents // [])[]
      | select(
          (.Key | type) == "string"
          and (.LastModified | type) == "string"
          and (.Size | type) == "number"
          and (.Key | startswith($prefix))
        )
    ]
    | sort_by(.LastModified, .Key)
    | if length == 0 then empty else last | [.Key, .LastModified, (.Size | tostring)] | @tsv end
  '
}

backup_exact_record_from_json() {
  local key="$1"
  jq --raw-output --arg key "$key" '
    [
      (.Contents // [])[]
      | select(
          .Key == $key
          and (.LastModified | type) == "string"
          and (.Size | type) == "number"
        )
    ]
    | if length == 1 then first | [.Key, .LastModified, (.Size | tostring)] | @tsv else empty end
  '
}

backup_latest_record() {
  local prefix="$1"
  local inventory
  inventory="$(backup_list_objects_json "$prefix")" || return 1
  printf '%s\n' "$inventory" | backup_validate_inventory_records || return 1
  printf '%s\n' "$inventory" | backup_latest_record_from_json "$prefix"
}

backup_exact_record() {
  local key="$1"
  local inventory
  inventory="$(backup_list_objects_json "$key")" || return 1
  printf '%s\n' "$inventory" | backup_validate_inventory_records || return 1
  printf '%s\n' "$inventory" | backup_exact_record_from_json "$key"
}

backup_head_object_json() {
  local key="$1"
  aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3api head-object \
    --bucket "$R2_BACKUP_BUCKET" \
    --key "$key" \
    --output json
}

backup_validate_head_object_json() {
  jq --exit-status '
    (.ContentLength | type) == "number"
    and .ContentLength >= 0
    and (.ContentLength | floor) == .ContentLength
    and (.ETag | type) == "string"
    and (.ETag | length) > 0
    and (.LastModified | type) == "string"
    and ((.Metadata // {}) | type) == "object"
  ' > /dev/null
}

backup_head_identity_from_json() {
  jq --exit-status --compact-output --sort-keys '
    {
      contentLength: .ContentLength,
      encryptedSha256: ((.Metadata // {})["encrypted-sha256"] // ""),
      etag: .ETag,
      lastModified: .LastModified
    }
  '
}

backup_download_object_if_match() {
  local key="$1"
  local etag="$2"
  local destination="$3"
  aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3api get-object \
    --bucket "$R2_BACKUP_BUCKET" \
    --key "$key" \
    --if-match "$etag" \
    "$destination" \
    --output json > /dev/null
}

backup_object_age_seconds() {
  local last_modified="$1"

  local modified_epoch
  if ! modified_epoch="$(date --date="$last_modified" +%s 2>/dev/null)"; then
    echo "Backup object has an invalid LastModified timestamp" >&2
    return 1
  fi
  local now_epoch="${BACKUP_NOW_EPOCH:-$(date -u +%s)}"
  backup_require_uint "current epoch" "$now_epoch" || return 1
  local age_seconds=$((now_epoch - modified_epoch))
  if ((age_seconds < 0)); then
    echo "Backup object LastModified timestamp is in the future" >&2
    return 1
  fi
  printf '%s\n' "$age_seconds"
}

backup_assert_fresh_last_modified() {
  local last_modified="$1"
  local maximum_age_seconds="$2"
  backup_require_uint "maximum backup age" "$maximum_age_seconds" || return 1

  local age_seconds
  age_seconds="$(backup_object_age_seconds "$last_modified")" || return 1
  if ((age_seconds > maximum_age_seconds)); then
    echo "Backup object is stale: ${age_seconds} seconds old (maximum ${maximum_age_seconds})" >&2
    return 1
  fi
  printf '%s\n' "$age_seconds"
}

backup_is_new_key() {
  local kind="$1"
  local key="$2"
  [[ "$kind" == "weekly" || "$kind" == "manual" ]] || return 1
  [[ "$key" =~ ^${kind}/meoing-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z\.tar\.age$ ]]
}

backup_is_legacy_weekly_key() {
  local key="$1"
  [[ "$key" =~ ^weekly/meoing-[0-9]{4}-W[0-9]{2}\.tar\.age$ ]]
}

backup_is_legacy_daily_key() {
  local key="$1"
  [[ "$key" =~ ^daily/meoing-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z\.tar\.age$ ]]
}

backup_is_restorable_key() {
  local key="$1"
  backup_is_new_key weekly "$key" \
    || backup_is_new_key manual "$key" \
    || backup_is_legacy_weekly_key "$key"
}

backup_verification_marker_key() {
  local backup_key="$1"
  printf 'verified/%s.json\n' "$backup_key"
}

backup_validate_manifest_identity() {
  local manifest_file="$1"
  local backup_key="$2"
  if backup_is_new_key weekly "$backup_key" || backup_is_new_key manual "$backup_key"; then
    jq --exit-status --arg backupKey "$backup_key" '
      .formatVersion == 2
      and .backupKey == $backupKey
      and (.createdAt | type) == "string"
      and (.dumpSha256 | test("^[a-f0-9]{64}$"))
      and (.tables | type) == "object"
      and (.tables | length) == 22
    ' "$manifest_file" > /dev/null
    return
  fi

  if backup_is_legacy_weekly_key "$backup_key"; then
    jq --exit-status '
      .formatVersion == 1
      and (.createdAt | type) == "string"
      and (.dumpSha256 | test("^[a-f0-9]{64}$"))
      and (.tables | type) == "object"
      and (.tables | length) == 22
    ' "$manifest_file" > /dev/null
    return
  fi

  echo "Backup manifest key is not restorable" >&2
  return 1
}

backup_validate_verification_marker() {
  local marker_file="$1"
  local backup_key="$2"
  if ! jq --exit-status --arg backupKey "$backup_key" '
      (keys | sort) == [
        "backupKey",
        "dumpSha256",
        "encryptedSha256",
        "encryptedSize",
        "formatVersion",
        "manifestCreatedAt",
        "objectEtag",
        "verifiedAt"
      ]
      and .formatVersion == 2
      and .backupKey == $backupKey
      and (.verifiedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
      and (.manifestCreatedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
      and (.dumpSha256 | test("^[a-f0-9]{64}$"))
      and (.encryptedSha256 | test("^[a-f0-9]{64}$"))
      and (.encryptedSize | type) == "number"
      and .encryptedSize > 0
      and (.encryptedSize | floor) == .encryptedSize
      and (.objectEtag | type) == "string"
      and (.objectEtag | test("^[^\\r\\n\\t]{1,200}$"))
    ' "$marker_file" > /dev/null; then
    return 1
  fi

  local verified_at
  local manifest_created_at
  local verified_epoch
  local manifest_epoch
  verified_at="$(jq --exit-status --raw-output '.verifiedAt' "$marker_file")" || return 1
  manifest_created_at="$(jq --exit-status --raw-output '.manifestCreatedAt' "$marker_file")" || return 1
  verified_epoch="$(date --date="$verified_at" +%s 2>/dev/null)" || return 1
  manifest_epoch="$(date --date="$manifest_created_at" +%s 2>/dev/null)" || return 1
  if ((verified_epoch < manifest_epoch)); then
    return 1
  fi
}

backup_assert_marker_matches_head() {
  local marker_file="$1"
  local backup_key="$2"
  local head_json="$3"
  printf '%s\n' "$head_json" | backup_validate_head_object_json || return 1

  local object_etag
  local object_size
  local object_sha256
  object_etag="$(printf '%s\n' "$head_json" | jq --exit-status --raw-output '.ETag')" || return 1
  object_size="$(printf '%s\n' "$head_json" | jq --exit-status --raw-output '.ContentLength')" || return 1
  object_sha256="$(printf '%s\n' "$head_json" | jq --exit-status --raw-output '(.Metadata // {})["encrypted-sha256"] // ""')" || return 1

  if ! jq --exit-status \
      --arg etag "$object_etag" \
      --argjson size "$object_size" \
      --arg encryptedSha256 "$object_sha256" '
        .objectEtag == $etag
        and .encryptedSize == $size
        and (
          if $encryptedSha256 == "" then true
          else .encryptedSha256 == $encryptedSha256
          end
        )
      ' "$marker_file" > /dev/null; then
    return 1
  fi

  if backup_is_new_key weekly "$backup_key" || backup_is_new_key manual "$backup_key"; then
    backup_require_sha256 "R2 encrypted-sha256 metadata" "$object_sha256" || return 1
  fi

  local manifest_created_at
  local object_last_modified
  local manifest_created_epoch
  local object_modified_epoch
  manifest_created_at="$(jq --exit-status --raw-output '.manifestCreatedAt' "$marker_file")" || return 1
  object_last_modified="$(printf '%s\n' "$head_json" | jq --exit-status --raw-output '.LastModified')" || return 1
  manifest_created_epoch="$(date --date="$manifest_created_at" +%s 2>/dev/null)" || return 1
  object_modified_epoch="$(date --date="$object_last_modified" +%s 2>/dev/null)" || return 1
  if ((manifest_created_epoch > object_modified_epoch + 300)); then
    echo "Verification marker recovery point is later than the encrypted object" >&2
    return 1
  fi
}

backup_validate_inventory_records() {
  jq --exit-status '
    (.Contents // [])
    | all(.[];
        (.Key | type) == "string"
        and (.LastModified | type) == "string"
        and (.Size | type) == "number"
        and .Size >= 0
        and (.Size | floor) == .Size
        and ((.ETag // "") | type) == "string"
      )
  ' > /dev/null
}

backup_prune_candidates_from_json() {
  local keep="$1"
  backup_require_uint "retained backup count" "$keep" || return 1
  jq --raw-output --argjson keep "$keep" '
    (.Contents // [])
    | sort_by(.LastModified, .Key)
    | if length <= $keep then [] else .[0:(length - $keep)] end
    | .[]
    | [.Key, .LastModified, (.Size | tostring)]
    | @tsv
  '
}

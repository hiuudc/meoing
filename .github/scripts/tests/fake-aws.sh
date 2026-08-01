#!/usr/bin/env bash
set -euo pipefail

: "${FAKE_AWS_FIXTURE_DIR:?FAKE_AWS_FIXTURE_DIR is required}"
: "${FAKE_AWS_LOG:?FAKE_AWS_LOG is required}"

arguments=("$@")
service_index=-1
for index in "${!arguments[@]}"; do
  if [[ "${arguments[$index]}" == "s3api" || "${arguments[$index]}" == "s3" ]]; then
    service_index="$index"
    break
  fi
done
if ((service_index < 0)); then
  echo "fake aws received no service" >&2
  exit 1
fi
service="${arguments[$service_index]}"
operation="${arguments[$((service_index + 1))]}"

argument_value() {
  local requested="$1"
  local index
  for index in "${!arguments[@]}"; do
    if [[ "${arguments[$index]}" == "$requested" ]]; then
      printf '%s\n' "${arguments[$((index + 1))]}"
      return 0
    fi
  done
  return 1
}

has_argument() {
  local requested="$1"
  local argument
  for argument in "${arguments[@]}"; do
    if [[ "$argument" == "$requested" ]]; then
      return 0
    fi
  done
  return 1
}

fixture_for_key() {
  local key="$1"
  case "$key" in
    weekly/*)
      printf '%s\n' "${FAKE_WEEKLY_FIXTURE:-${FAKE_AWS_FIXTURE_DIR}/weekly-five-verified-one-unverified.json}"
      ;;
    verified/weekly/*)
      printf '%s\n' "${FAKE_MARKER_FIXTURE:-${FAKE_AWS_FIXTURE_DIR}/verified-five.json}"
      ;;
    daily/*)
      printf '%s\n' "${FAKE_DAILY_FIXTURE:-${FAKE_AWS_FIXTURE_DIR}/allocation-daily.json}"
      ;;
    manual/*)
      printf '%s\n' "${FAKE_MANUAL_FIXTURE:-${FAKE_AWS_FIXTURE_DIR}/allocation-manual.json}"
      ;;
    verified/manual/*)
      printf '%s\n' "${FAKE_MANUAL_MARKER_FIXTURE:-${FAKE_AWS_FIXTURE_DIR}/empty.json}"
      ;;
    *)
      printf '%s\n' "${FAKE_AWS_FIXTURE_DIR}/empty.json"
      ;;
  esac
}

fake_object_head() {
  local key="$1"
  local fixture
  fixture="$(fixture_for_key "$key")"
  local record
  record="$(jq --compact-output --arg key "$key" '(.Contents // [])[] | select(.Key == $key)' "$fixture")"
  if [[ -z "$record" ]]; then
    echo "fake aws head-object did not find ${key}" >&2
    return 1
  fi
  local size
  local last_modified
  size="$(printf '%s\n' "$record" | jq --raw-output '.Size')"
  last_modified="$(printf '%s\n' "$record" | jq --raw-output '.LastModified')"
  local etag
  local metadata='{}'
  if [[ "$key" == verified/* ]]; then
    etag="\"marker-${size}\""
  else
    etag="\"backup-${size}\""
    metadata='{"encrypted-sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
  fi
  jq --null-input --compact-output \
    --argjson contentLength "$size" \
    --arg etag "$etag" \
    --arg lastModified "$last_modified" \
    --argjson metadata "$metadata" \
    '{ContentLength: $contentLength, ETag: $etag, LastModified: $lastModified, Metadata: $metadata}'
}

if [[ "$service" == "s3api" && "$operation" == "list-objects-v2" ]]; then
  prefix=""
  for index in "${!arguments[@]}"; do
    if [[ "${arguments[$index]}" == "--prefix" ]]; then
      prefix="${arguments[$((index + 1))]}"
      break
    fi
  done

  if [[ -n "${FAKE_PAGINATED_PREFIX:-}" && "$prefix" == "$FAKE_PAGINATED_PREFIX" ]]; then
    continuation_token="$(argument_value --continuation-token || true)"
    if [[ -z "$continuation_token" ]]; then
      cat "${FAKE_PAGINATED_FIRST_FIXTURE:?FAKE_PAGINATED_FIRST_FIXTURE is required}"
    elif [[ "$continuation_token" == "page-2" ]]; then
      cat "${FAKE_PAGINATED_SECOND_FIXTURE:?FAKE_PAGINATED_SECOND_FIXTURE is required}"
    else
      echo "fake aws received an unexpected continuation token" >&2
      exit 1
    fi
    exit 0
  fi

  weekly_fixture="${FAKE_WEEKLY_FIXTURE:-${FAKE_AWS_FIXTURE_DIR}/weekly-five-verified-one-unverified.json}"
  marker_fixture="${FAKE_MARKER_FIXTURE:-${FAKE_AWS_FIXTURE_DIR}/verified-five.json}"
  case "$prefix" in
    "")
      cat "${FAKE_BUCKET_FIXTURE:-${FAKE_AWS_FIXTURE_DIR}/bucket-allocation.json}"
      ;;
    weekly/)
      cat "$weekly_fixture"
      ;;
    verified/weekly/)
      cat "$marker_fixture"
      ;;
    daily/)
      cat "${FAKE_DAILY_FIXTURE:-${FAKE_AWS_FIXTURE_DIR}/allocation-daily.json}"
      ;;
    manual/)
      cat "${FAKE_MANUAL_FIXTURE:-${FAKE_AWS_FIXTURE_DIR}/allocation-manual.json}"
      ;;
    weekly/*)
      jq --arg key "$prefix" '{Contents: [(.Contents // [])[] | select(.Key == $key)]}' "$weekly_fixture"
      ;;
    manual/*)
      manual_fixture="${FAKE_MANUAL_FIXTURE:-${FAKE_AWS_FIXTURE_DIR}/allocation-manual.json}"
      jq --arg key "$prefix" '{Contents: [(.Contents // [])[] | select(.Key == $key)]}' "$manual_fixture"
      ;;
    daily/*)
      daily_fixture="${FAKE_DAILY_FIXTURE:-${FAKE_AWS_FIXTURE_DIR}/allocation-daily.json}"
      jq --arg key "$prefix" '{Contents: [(.Contents // [])[] | select(.Key == $key)]}' "$daily_fixture"
      ;;
    verified/weekly/*)
      jq --arg key "$prefix" '{Contents: [(.Contents // [])[] | select(.Key == $key)]}' "$marker_fixture"
      ;;
    verified/manual/*)
      manual_marker_fixture="${FAKE_MANUAL_MARKER_FIXTURE:-${FAKE_AWS_FIXTURE_DIR}/empty.json}"
      jq --arg key "$prefix" '{Contents: [(.Contents // [])[] | select(.Key == $key)]}' "$manual_marker_fixture"
      ;;
    *)
      cat "${FAKE_AWS_FIXTURE_DIR}/empty.json"
      ;;
  esac
  exit 0
fi

if [[ "$service" == "s3api" && "$operation" == "head-object" ]]; then
  key="$(argument_value --key)"
  fake_object_head "$key"
  exit 0
fi

if [[ "$service" == "s3api" && "$operation" == "get-object" ]]; then
  key="$(argument_value --key)"
  requested_etag="$(argument_value --if-match)"
  expected_etag="$(fake_object_head "$key" | jq --raw-output '.ETag')"
  if [[ "$requested_etag" != "$expected_etag" ]]; then
    echo "fake aws get-object If-Match did not match ${key}" >&2
    exit 1
  fi
  destination_path=""
  for index in "${!arguments[@]}"; do
    if [[ "${arguments[$index]}" == "--if-match" ]]; then
      destination_path="${arguments[$((index + 2))]}"
      break
    fi
  done
  if [[ -z "$destination_path" ]]; then
    echo "fake aws get-object received no destination" >&2
    exit 1
  fi
  printf 'get-object\t%s\t%s\n' "$key" "$destination_path" >> "$FAKE_AWS_LOG"
  if [[ "$key" == verified/* ]]; then
    if [[ "$key" == "${FAKE_INVALID_MARKER_KEY:-__no_invalid_marker__}" ]]; then
      cp "${FAKE_INVALID_MARKER_FIXTURE:-${FAKE_AWS_FIXTURE_DIR}/invalid-verification-marker.json}" "$destination_path"
      printf '{}\n'
      exit 0
    fi
    backup_key="${key#verified/}"
    backup_key="${backup_key%.json}"
    backup_head="$(fake_object_head "$backup_key")"
    backup_size="$(printf '%s\n' "$backup_head" | jq --raw-output '.ContentLength')"
    backup_etag="$(printf '%s\n' "$backup_head" | jq --raw-output '.ETag')"
    backup_last_modified="$(printf '%s\n' "$backup_head" | jq --raw-output '.LastModified')"
    manifest_created_at="$(date --date="$backup_last_modified - 1 minute" -u +%Y-%m-%dT%H:%M:%SZ)"
    verified_at="$(date --date="$backup_last_modified + 36 minutes" -u +%Y-%m-%dT%H:%M:%SZ)"
    jq --null-input --compact-output \
      --arg backupKey "$backup_key" \
      --arg manifestCreatedAt "$manifest_created_at" \
      --arg objectEtag "$backup_etag" \
      --arg verifiedAt "$verified_at" \
      --argjson encryptedSize "$backup_size" \
      '{
        formatVersion: 2,
        backupKey: $backupKey,
        verifiedAt: $verifiedAt,
        manifestCreatedAt: $manifestCreatedAt,
        dumpSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        encryptedSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        encryptedSize: $encryptedSize,
        objectEtag: $objectEtag
      }' > "$destination_path"
  else
    printf 'encrypted-fixture' > "$destination_path"
  fi
  printf '{}\n'
  exit 0
fi

if [[ "$service" == "s3api" && "$operation" == "put-object" ]]; then
  key="$(argument_value --key)"
  body="$(argument_value --body)"
  if has_argument --if-none-match \
    && [[ "$key" == "${FAKE_EXISTING_OBJECT_KEY:-__no_existing_object__}" ]]; then
    echo "fake aws rejected create-only overwrite for ${key}" >&2
    exit 1
  fi
  if has_argument --if-match; then
    requested_etag="$(argument_value --if-match)"
    if [[ -n "${FAKE_EXPECTED_PUT_ETAG:-}" && "$requested_etag" != "$FAKE_EXPECTED_PUT_ETAG" ]]; then
      echo "fake aws rejected stale PutObject If-Match for ${key}" >&2
      exit 1
    fi
  fi
  printf 'put-object\t%s\t%s\n' "$key" "$body" >> "$FAKE_AWS_LOG"
  printf '{"ETag":"\\"uploaded\\""}\n'
  exit 0
fi

if [[ "$service" == "s3" && "$operation" == "cp" ]]; then
  source_path="${arguments[$((service_index + 2))]}"
  destination_path="${arguments[$((service_index + 3))]}"
  printf 'cp\t%s\t%s\n' "$source_path" "$destination_path" >> "$FAKE_AWS_LOG"
  if [[ "$source_path" == s3://*/verified/weekly/*.json ]]; then
    object_key="${source_path#s3://"${R2_BACKUP_BUCKET}"/}"
    backup_key="${object_key#verified/}"
    backup_key="${backup_key%.json}"
    jq --null-input --compact-output \
      --arg backupKey "$backup_key" \
      '{
        formatVersion: 1,
        backupKey: $backupKey,
        verifiedAt: "2026-08-17T03:00:00Z",
        manifestCreatedAt: "2026-08-17T02:23:00Z",
        dumpSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }' > "$destination_path"
  fi
  exit 0
fi

if [[ "$service" == "s3" && "$operation" == "rm" ]]; then
  object_path="${arguments[$((service_index + 2))]}"
  printf 'rm\t%s\n' "$object_path" >> "$FAKE_AWS_LOG"
  exit 0
fi

echo "fake aws does not implement ${service} ${operation}" >&2
exit 1

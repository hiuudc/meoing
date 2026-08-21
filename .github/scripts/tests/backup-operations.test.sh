#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_dir}/../../.." && pwd)"
# shellcheck source=../backup-storage.sh
source "${script_dir}/../backup-storage.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_equal() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail "${label}: expected '${expected}', got '${actual}'"
  fi
}

daily_fixture="${script_dir}/fixtures/allocation-daily.json"
manual_fixture="${script_dir}/fixtures/allocation-manual.json"
weekly_fixture="${script_dir}/fixtures/weekly-unsorted.json"

daily_bytes="$(backup_inventory_bytes_from_json < "$daily_fixture")"
manual_bytes="$(backup_inventory_bytes_from_json < "$manual_fixture")"
weekly_bytes="$(backup_inventory_bytes_from_json < "$weekly_fixture")"
backup_validate_inventory_records < "$weekly_fixture"
assert_equal "300" "$daily_bytes" "legacy daily allocation"
assert_equal "700" "$manual_bytes" "manual allocation"
assert_equal "2100" "$weekly_bytes" "weekly allocation"

projected="$(backup_assert_projected_allocation 3100 900 4000)"
assert_equal "4000" "$projected" "allocation at exact limit"
if backup_assert_projected_allocation 3100 901 4000 > /dev/null 2>&1; then
  fail "projected allocation above the limit must fail"
fi
if backup_assert_projected_allocation 4001 0 4000 > /dev/null 2>&1; then
  fail "existing allocation above the limit must fail before backup"
fi

backup_require_supabase_project_ref \
  "EXPECTED_SUPABASE_PROJECT_REF" \
  "abcdefghijklmnopqrst"
if backup_require_supabase_project_ref \
  "EXPECTED_SUPABASE_PROJECT_REF" \
  "not-a-project-ref" > /dev/null 2>&1; then
  fail "production backup project ref must be independently pinned"
fi
backup_assert_tls_database_url \
  'postgresql://postgres:secret@db.example.invalid/postgres?sslmode=require'
backup_assert_tls_database_url \
  'postgres://postgres:secret@db.example.invalid/postgres?application_name=backup&sslmode=verify-full'
for insecure_database_url in \
  'postgresql://postgres:secret@db.example.invalid/postgres' \
  'postgresql://postgres:secret@db.example.invalid/postgres?sslmode=disable' \
  'postgresql://postgres:secret@db.example.invalid/postgres?sslmode=prefer' \
  'postgresql://postgres:secret@db.example.invalid/postgres?sslmode=require&sslmode=verify-full'; do
  if backup_assert_tls_database_url "$insecure_database_url" > /dev/null 2>&1; then
    fail "production backup URL must reject missing, weak, or duplicate sslmode"
  fi
done
backup_assert_production_database_identity \
  "abcdefghijklmnopqrst" \
  "production/abcdefghijklmnopqrst/tls=true"
if backup_assert_production_database_identity \
  "abcdefghijklmnopqrst" \
  "staging/abcdefghijklmnopqrst/tls=true" > /dev/null 2>&1; then
  fail "production backup must reject a staging database marker"
fi
if backup_assert_production_database_identity \
  "abcdefghijklmnopqrst" \
  "production/abcdefghijklmnopqrst/tls=false" > /dev/null 2>&1; then
  fail "production backup must reject a non-TLS database session"
fi

latest_record="$(backup_latest_record_from_json weekly/ < "$weekly_fixture")"
IFS=$'\t' read -r latest_key latest_modified latest_size <<< "$latest_record"
assert_equal "weekly/meoing-2026-08-24T02-23-00Z.tar.age" "$latest_key" "latest key by LastModified"
assert_equal "2026-08-24T02:24:00Z" "$latest_modified" "latest LastModified"
assert_equal "600" "$latest_size" "latest size"

mapfile -t prune_candidates < <(backup_prune_candidates_from_json 4 < "$weekly_fixture")
assert_equal "2" "${#prune_candidates[@]}" "weekly prune candidate count"
IFS=$'\t' read -r first_pruned _first_modified _first_size <<< "${prune_candidates[0]}"
IFS=$'\t' read -r second_pruned _second_modified _second_size <<< "${prune_candidates[1]}"
assert_equal "weekly/meoing-2026-W30.tar.age" "$first_pruned" "oldest candidate selected by LastModified"
assert_equal "weekly/meoing-2026-07-27T02-23-00Z.tar.age" "$second_pruned" "second-oldest candidate"

BACKUP_NOW_EPOCH="$(date --date='2026-08-09T02:23:00Z' +%s)"
age="$(backup_assert_fresh_last_modified '2026-08-01T02:23:00Z' 691200)"
assert_equal "691200" "$age" "exactly eight days remains fresh"
if backup_assert_fresh_last_modified '2026-08-01T02:22:59Z' 691200 > /dev/null 2>&1; then
  fail "backup older than eight days must fail"
fi
unset BACKUP_NOW_EPOCH

backup_is_new_key weekly "weekly/meoing-2026-08-02T02-23-00Z.tar.age" \
  || fail "new weekly key must validate"
backup_is_new_key manual "manual/meoing-2026-08-02T02-23-00Z.tar.age" \
  || fail "new manual key must validate"
backup_is_legacy_weekly_key "weekly/meoing-2026-W31.tar.age" \
  || fail "legacy weekly key must remain restorable during migration"
if backup_is_new_key weekly "manual/meoing-2026-08-02T02-23-00Z.tar.age"; then
  fail "manual key must not validate as weekly"
fi

marker_key="$(backup_verification_marker_key 'weekly/meoing-2026-08-02T02-23-00Z.tar.age')"
assert_equal \
  "verified/weekly/meoing-2026-08-02T02-23-00Z.tar.age.json" \
  "$marker_key" \
  "verification marker key"
if backup_validate_verification_marker \
  "${script_dir}/fixtures/invalid-verification-marker.json" \
  "weekly/meoing-2026-08-17T02-23-00Z.tar.age"; then
  fail "verification marker with an invalid timestamp must fail"
fi

mock_root="$(mktemp -d)"
trap 'rm -rf -- "$mock_root"' EXIT
cp "${script_dir}/fake-aws.sh" "${mock_root}/aws"
chmod +x "${mock_root}/aws"
export PATH="${mock_root}:${PATH}"
export FAKE_AWS_FIXTURE_DIR="${script_dir}/fixtures"
export FAKE_AWS_LOG="${mock_root}/aws.log"
export R2_BACKUP_ENDPOINT="https://backup.example.invalid"
export R2_BACKUP_BUCKET="backup-bucket"
BACKUP_NOW_EPOCH="$(date --date='2026-08-24T03:30:00Z' +%s)"
export BACKUP_NOW_EPOCH

export FAKE_PAGINATED_PREFIX="manual/"
export FAKE_PAGINATED_FIRST_FIXTURE="${script_dir}/fixtures/paginated-first.json"
export FAKE_PAGINATED_SECOND_FIXTURE="${script_dir}/fixtures/paginated-second.json"
paginated_inventory="$(backup_list_objects_json manual/)"
assert_equal \
  "2" \
  "$(printf '%s\n' "$paginated_inventory" | backup_inventory_count_from_json)" \
  "explicit continuation-token pagination"
assert_equal \
  "300" \
  "$(printf '%s\n' "$paginated_inventory" | backup_inventory_bytes_from_json)" \
  "allocation includes every paginated object"
unset FAKE_PAGINATED_PREFIX FAKE_PAGINATED_FIRST_FIXTURE FAKE_PAGINATED_SECOND_FIXTURE

conditional_body="${mock_root}/conditional-body.json"
printf '{}\n' > "$conditional_body"
export FAKE_EXISTING_OBJECT_KEY="manual/meoing-2026-08-24T02-23-00Z.tar.age"
if aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3api put-object \
  --bucket "$R2_BACKUP_BUCKET" \
  --key "$FAKE_EXISTING_OBJECT_KEY" \
  --body "$conditional_body" \
  --if-none-match '*' > /dev/null 2>&1; then
  fail "create-only PutObject must reject an existing immutable key"
fi
unset FAKE_EXISTING_OBJECT_KEY
export FAKE_EXPECTED_PUT_ETAG='"current-marker"'
if aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3api put-object \
  --bucket "$R2_BACKUP_BUCKET" \
  --key "verified/manual/meoing-2026-08-24T02-23-00Z.tar.age.json" \
  --body "$conditional_body" \
  --if-match '"stale-marker"' > /dev/null 2>&1; then
  fail "marker PutObject must reject a stale CAS ETag"
fi
unset FAKE_EXPECTED_PUT_ETAG

valid_manifest="${mock_root}/manifest-valid.json"
jq --null-input --compact-output \
  --arg backupKey "weekly/meoing-2026-08-17T02-23-00Z.tar.age" '
    {
      formatVersion: 2,
      backupKey: $backupKey,
      createdAt: "2026-08-17T02:23:00Z",
      dumpSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      tables: (reduce range(0; 22) as $index ({}; . + {($index | tostring): 0}))
    }
  ' > "$valid_manifest"
backup_validate_manifest_identity \
  "$valid_manifest" \
  "weekly/meoing-2026-08-17T02-23-00Z.tar.age" \
  || fail "format-v2 manifest must bind to its exact immutable backup key"
if backup_validate_manifest_identity \
  "$valid_manifest" \
  "weekly/meoing-2026-08-24T02-23-00Z.tar.age"; then
  fail "a replayed archive under a different weekly key must fail manifest validation"
fi

matching_head="$(backup_head_object_json 'weekly/meoing-2026-08-17T02-23-00Z.tar.age')"
matching_marker="${mock_root}/matching-marker.json"
matching_marker_key="$(backup_verification_marker_key 'weekly/meoing-2026-08-17T02-23-00Z.tar.age')"
backup_download_object_if_match \
  "$matching_marker_key" \
  "$(backup_head_object_json "$matching_marker_key" | jq --raw-output '.ETag')" \
  "$matching_marker"
backup_validate_verification_marker \
  "$matching_marker" \
  "weekly/meoing-2026-08-17T02-23-00Z.tar.age"
backup_assert_marker_matches_head \
  "$matching_marker" \
  "weekly/meoing-2026-08-17T02-23-00Z.tar.age" \
  "$matching_head"
changed_head="$(printf '%s\n' "$matching_head" | jq '.ETag = "\\\"replaced-object\\\""')"
if backup_assert_marker_matches_head \
  "$matching_marker" \
  "weekly/meoing-2026-08-17T02-23-00Z.tar.age" \
  "$changed_head"; then
  fail "verification marker must reject a replaced ciphertext identity"
fi
future_marker="${mock_root}/future-marker.json"
jq '.manifestCreatedAt = "2026-08-18T02:23:00Z" | .verifiedAt = "2026-08-18T03:00:00Z"' \
  "$matching_marker" > "$future_marker"
if backup_assert_marker_matches_head \
  "$future_marker" \
  "weekly/meoing-2026-08-17T02-23-00Z.tar.age" \
  "$matching_head" > /dev/null 2>&1; then
  fail "verification marker must not move the recovery point after object creation"
fi

: > "$FAKE_AWS_LOG"
bucket_allocation="$(backup_allocation_bytes)"
assert_equal "3220" "$bucket_allocation" "entire backup bucket allocation"

export FAKE_BUCKET_FIXTURE="${script_dir}/fixtures/bucket-over-limit.json"
if BACKUP_KIND=weekly \
  BACKUP_MAX_ALLOCATION_BYTES=3221225472 \
  SUPABASE_PRODUCTION_DB_URL='postgresql://backup.invalid/postgres?sslmode=require' \
  EXPECTED_SUPABASE_PROJECT_REF='abcdefghijklmnopqrst' \
  BACKUP_AGE_RECIPIENT='age1test' \
    bash "${script_dir}/../backup-production.sh" > "${mock_root}/over-limit.out" 2>&1; then
  fail "backup creation must fail its whole-bucket preflight above 3 GiB"
fi
unset FAKE_BUCKET_FIXTURE

: > "$FAKE_AWS_LOG"
VERIFIED_BACKUP_KEY="weekly/meoing-2026-08-17T02-23-00Z.tar.age" \
WEEKLY_BACKUP_KEEP_COUNT=4 \
RESTORE_MAX_AGE_SECONDS=691200 \
  bash "${script_dir}/../prune-production-backups.sh" > "${mock_root}/prune.out"
grep --fixed-strings --quiet \
  $'rm\ts3://backup-bucket/weekly/meoing-2026-07-20T02-23-00Z.tar.age' \
  "$FAKE_AWS_LOG" \
  || fail "oldest verified backup must be pruned"
grep --fixed-strings --quiet \
  $'rm\ts3://backup-bucket/verified/weekly/meoing-2026-07-20T02-23-00Z.tar.age.json' \
  "$FAKE_AWS_LOG" \
  || fail "pruned verified backup marker must be removed"
if grep --fixed-strings $'rm\t' "$FAKE_AWS_LOG" | grep --fixed-strings --quiet '2026-08-24'; then
  fail "newer unverified backup must not consume a slot or be pruned"
fi
rm_count="$(grep --count $'^rm\t' "$FAKE_AWS_LOG")"
assert_equal "2" "$rm_count" "one verified backup and marker deletion"

: > "$FAKE_AWS_LOG"
export FAKE_MARKER_FIXTURE="${script_dir}/fixtures/empty.json"
if VERIFIED_BACKUP_KEY="weekly/meoing-2026-08-17T02-23-00Z.tar.age" \
  WEEKLY_BACKUP_KEEP_COUNT=4 \
  RESTORE_MAX_AGE_SECONDS=691200 \
    bash "${script_dir}/../prune-production-backups.sh" > "${mock_root}/missing-marker.out" 2>&1; then
  fail "retention must fail when the just-restored key lacks a valid marker"
fi
if grep --quiet $'^rm\t' "$FAKE_AWS_LOG"; then
  fail "missing verification marker must cause no pruning"
fi
unset FAKE_MARKER_FIXTURE

: > "$FAKE_AWS_LOG"
if RESTORE_MAX_AGE_SECONDS=691200 \
  bash "${script_dir}/../check-backup-freshness.sh" > "${mock_root}/unverified-latest.out" 2>&1; then
  fail "freshness monitor must fail when the newest weekly object is unverified"
fi
export FAKE_WEEKLY_FIXTURE="${script_dir}/fixtures/weekly-healthy.json"
RESTORE_MAX_AGE_SECONDS=691200 \
  bash "${script_dir}/../check-backup-freshness.sh" > "${mock_root}/freshness.out"
grep --fixed-strings --quiet 'Backup freshness healthy' "${mock_root}/freshness.out" \
  || fail "fresh verified weekly object must pass the independent monitor"

: > "$FAKE_AWS_LOG"
export FAKE_MARKER_FIXTURE="${script_dir}/fixtures/empty.json"
legacy_daily_digest="$(backup_inventory_digest_from_json < "$daily_fixture")"
LEGACY_CLEANUP_MODE=preview \
RESTORE_MAX_AGE_SECONDS=691200 \
  bash "${script_dir}/../cleanup-legacy-daily.sh" > "${mock_root}/cleanup-preview.out"
grep --fixed-strings --quiet 'Preview only; no legacy objects were deleted' "${mock_root}/cleanup-preview.out" \
  || fail "legacy cleanup preview must remain non-destructive"
if grep --quiet $'^rm\t' "$FAKE_AWS_LOG"; then
  fail "legacy cleanup preview must issue no delete request"
fi
unset FAKE_MARKER_FIXTURE

: > "$FAKE_AWS_LOG"
if LEGACY_CLEANUP_MODE=delete \
  LEGACY_DAILY_EXPECTED_COUNT=3 \
  LEGACY_DAILY_EXPECTED_DIGEST="$legacy_daily_digest" \
  LEGACY_DAILY_CLEANUP_CONFIRMATION='DELETE LEGACY DAILY BACKUPS' \
  RESTORE_MAX_AGE_SECONDS=691200 \
    bash "${script_dir}/../cleanup-legacy-daily.sh" > "${mock_root}/cleanup-wrong-count.out" 2>&1; then
  fail "legacy cleanup must reject a changed object count"
fi
if grep --quiet $'^rm\t' "$FAKE_AWS_LOG"; then
  fail "legacy cleanup count mismatch must issue no delete request"
fi

: > "$FAKE_AWS_LOG"
if LEGACY_CLEANUP_MODE=delete \
  LEGACY_DAILY_EXPECTED_COUNT=2 \
  LEGACY_DAILY_EXPECTED_DIGEST="$legacy_daily_digest" \
  LEGACY_DAILY_CLEANUP_CONFIRMATION='not confirmed' \
  RESTORE_MAX_AGE_SECONDS=691200 \
    bash "${script_dir}/../cleanup-legacy-daily.sh" > "${mock_root}/cleanup-wrong-confirmation.out" 2>&1; then
  fail "legacy cleanup must require the exact destructive confirmation"
fi
if grep --quiet $'^rm\t' "$FAKE_AWS_LOG"; then
  fail "legacy cleanup confirmation mismatch must issue no delete request"
fi

: > "$FAKE_AWS_LOG"
export FAKE_DAILY_FIXTURE="${script_dir}/fixtures/allocation-daily-same-count-changed.json"
if LEGACY_CLEANUP_MODE=delete \
  LEGACY_DAILY_EXPECTED_COUNT=2 \
  LEGACY_DAILY_EXPECTED_DIGEST="$legacy_daily_digest" \
  LEGACY_DAILY_CLEANUP_CONFIRMATION='DELETE LEGACY DAILY BACKUPS' \
  RESTORE_MAX_AGE_SECONDS=691200 \
    bash "${script_dir}/../cleanup-legacy-daily.sh" > "${mock_root}/cleanup-same-count-change.out" 2>&1; then
  fail "legacy cleanup must reject a same-count inventory replacement"
fi
if grep --quiet $'^rm\t' "$FAKE_AWS_LOG"; then
  fail "same-count legacy inventory change must issue no delete request"
fi
unset FAKE_DAILY_FIXTURE

: > "$FAKE_AWS_LOG"
LEGACY_CLEANUP_MODE=delete \
  LEGACY_DAILY_EXPECTED_COUNT=2 \
  LEGACY_DAILY_EXPECTED_DIGEST="$legacy_daily_digest" \
  LEGACY_DAILY_CLEANUP_CONFIRMATION='DELETE LEGACY DAILY BACKUPS' \
RESTORE_MAX_AGE_SECONDS=691200 \
  bash "${script_dir}/../cleanup-legacy-daily.sh" > "${mock_root}/cleanup-delete.out"
cleanup_rm_count="$(grep --count $'^rm\t' "$FAKE_AWS_LOG")"
assert_equal "4" "$cleanup_rm_count" "two legacy daily objects and markers deleted explicitly"
grep --fixed-strings --quiet \
  $'rm\ts3://backup-bucket/daily/meoing-2026-07-29T02-23-00Z.tar.age' \
  "$FAKE_AWS_LOG" \
  || fail "confirmed cleanup must delete the exact previewed daily key"

: > "$FAKE_AWS_LOG"
manual_output="${mock_root}/manual-cleanup-preview.out"
manual_github_output="${mock_root}/manual-cleanup-preview.github-output"
GITHUB_OUTPUT="$manual_github_output" \
BACKUP_CLEANUP_SCOPE=manual \
BACKUP_CLEANUP_MODE=preview \
BACKUP_CLEANUP_MINIMUM_AGE_SECONDS=691200 \
  bash "${script_dir}/../cleanup-unretained-backups.sh" > "$manual_output"
manual_candidate_count="$(sed -n 's/^object_count=//p' "$manual_github_output")"
manual_candidate_digest="$(sed -n 's/^inventory_digest=//p' "$manual_github_output")"
assert_equal "1" "$manual_candidate_count" "expired manual cleanup candidate count"
backup_require_sha256 "manual cleanup preview digest" "$manual_candidate_digest"

: > "$FAKE_AWS_LOG"
if BACKUP_CLEANUP_SCOPE=manual \
  BACKUP_CLEANUP_MODE=delete \
  BACKUP_CLEANUP_MINIMUM_AGE_SECONDS=691200 \
  BACKUP_CLEANUP_EXPECTED_COUNT=1 \
  BACKUP_CLEANUP_EXPECTED_DIGEST=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  BACKUP_CLEANUP_CONFIRMATION='DELETE UNRETAINED BACKUPS' \
    bash "${script_dir}/../cleanup-unretained-backups.sh" > "${mock_root}/manual-cleanup-wrong-digest.out" 2>&1; then
  fail "manual cleanup must reject a mismatched exact inventory digest"
fi
if grep --quiet $'^rm\t' "$FAKE_AWS_LOG"; then
  fail "manual cleanup digest mismatch must issue no delete request"
fi

: > "$FAKE_AWS_LOG"
BACKUP_CLEANUP_SCOPE=manual \
BACKUP_CLEANUP_MODE=delete \
BACKUP_CLEANUP_MINIMUM_AGE_SECONDS=691200 \
BACKUP_CLEANUP_EXPECTED_COUNT="$manual_candidate_count" \
BACKUP_CLEANUP_EXPECTED_DIGEST="$manual_candidate_digest" \
BACKUP_CLEANUP_CONFIRMATION='DELETE UNRETAINED BACKUPS' \
  bash "${script_dir}/../cleanup-unretained-backups.sh" > "${mock_root}/manual-cleanup-delete.out"
assert_equal "1" "$(grep --count $'^rm\t' "$FAKE_AWS_LOG")" "manual object deletion without an orphan marker request"

: > "$FAKE_AWS_LOG"
export FAKE_WEEKLY_FIXTURE="${script_dir}/fixtures/weekly-old-unverified.json"
export FAKE_MARKER_FIXTURE="${script_dir}/fixtures/empty.json"
unverified_github_output="${mock_root}/unverified-cleanup-preview.github-output"
GITHUB_OUTPUT="$unverified_github_output" \
BACKUP_CLEANUP_SCOPE=unverified-weekly \
BACKUP_CLEANUP_MODE=preview \
BACKUP_CLEANUP_MINIMUM_AGE_SECONDS=691200 \
  bash "${script_dir}/../cleanup-unretained-backups.sh" > "${mock_root}/unverified-cleanup-preview.out"
unverified_candidate_count="$(sed -n 's/^object_count=//p' "$unverified_github_output")"
unverified_candidate_digest="$(sed -n 's/^inventory_digest=//p' "$unverified_github_output")"
assert_equal "1" "$unverified_candidate_count" "only old unverified weekly cleanup candidate"
BACKUP_CLEANUP_SCOPE=unverified-weekly \
BACKUP_CLEANUP_MODE=delete \
BACKUP_CLEANUP_MINIMUM_AGE_SECONDS=691200 \
BACKUP_CLEANUP_EXPECTED_COUNT="$unverified_candidate_count" \
BACKUP_CLEANUP_EXPECTED_DIGEST="$unverified_candidate_digest" \
BACKUP_CLEANUP_CONFIRMATION='DELETE UNRETAINED BACKUPS' \
  bash "${script_dir}/../cleanup-unretained-backups.sh" > "${mock_root}/unverified-cleanup-delete.out"
grep --fixed-strings --quiet \
  $'rm\ts3://backup-bucket/weekly/meoing-2026-08-03T02-23-00Z.tar.age' \
  "$FAKE_AWS_LOG" \
  || fail "approved old unverified weekly object must be deleted"
if grep --fixed-strings --quiet '2026-08-17' "$FAKE_AWS_LOG"; then
  fail "weekly object younger than eight days must not be deleted"
fi

: > "$FAKE_AWS_LOG"
export FAKE_WEEKLY_FIXTURE="${script_dir}/fixtures/weekly-legacy-unverified.json"
legacy_weekly_github_output="${mock_root}/legacy-weekly-cleanup-preview.github-output"
GITHUB_OUTPUT="$legacy_weekly_github_output" \
BACKUP_CLEANUP_SCOPE=unverified-weekly \
BACKUP_CLEANUP_MODE=preview \
BACKUP_CLEANUP_MINIMUM_AGE_SECONDS=691200 \
  bash "${script_dir}/../cleanup-unretained-backups.sh" > "${mock_root}/legacy-weekly-cleanup-preview.out"
legacy_weekly_candidate_count="$(sed -n 's/^object_count=//p' "$legacy_weekly_github_output")"
legacy_weekly_candidate_digest="$(sed -n 's/^inventory_digest=//p' "$legacy_weekly_github_output")"
assert_equal "1" "$legacy_weekly_candidate_count" "legacy weekly archive remains cleanup-reachable"
BACKUP_CLEANUP_SCOPE=unverified-weekly \
BACKUP_CLEANUP_MODE=delete \
BACKUP_CLEANUP_MINIMUM_AGE_SECONDS=691200 \
BACKUP_CLEANUP_EXPECTED_COUNT="$legacy_weekly_candidate_count" \
BACKUP_CLEANUP_EXPECTED_DIGEST="$legacy_weekly_candidate_digest" \
BACKUP_CLEANUP_CONFIRMATION='DELETE UNRETAINED BACKUPS' \
  bash "${script_dir}/../cleanup-unretained-backups.sh" > "${mock_root}/legacy-weekly-cleanup-delete.out"
grep --fixed-strings --quiet \
  $'rm\ts3://backup-bucket/weekly/meoing-2026-W31.tar.age' \
  "$FAKE_AWS_LOG" \
  || fail "approved migration-era unverified weekly object must be deleted"

: > "$FAKE_AWS_LOG"
export FAKE_WEEKLY_FIXTURE="${script_dir}/fixtures/weekly-invalid-marker.json"
export FAKE_MARKER_FIXTURE="${script_dir}/fixtures/verified-invalid-one.json"
valid_marker_github_output="${mock_root}/valid-marker-cleanup-preview.github-output"
GITHUB_OUTPUT="$valid_marker_github_output" \
BACKUP_CLEANUP_SCOPE=unverified-weekly \
BACKUP_CLEANUP_MODE=preview \
BACKUP_CLEANUP_MINIMUM_AGE_SECONDS=691200 \
  bash "${script_dir}/../cleanup-unretained-backups.sh" > "${mock_root}/valid-marker-cleanup-preview.out"
assert_equal \
  "0" \
  "$(sed -n 's/^object_count=//p' "$valid_marker_github_output")" \
  "valid matching weekly marker keeps an old archive out of unverified cleanup"

export FAKE_INVALID_MARKER_KEY="verified/weekly/meoing-2026-08-03T02-23-00Z.tar.age.json"
invalid_marker_github_output="${mock_root}/invalid-marker-cleanup-preview.github-output"
GITHUB_OUTPUT="$invalid_marker_github_output" \
BACKUP_CLEANUP_SCOPE=unverified-weekly \
BACKUP_CLEANUP_MODE=preview \
BACKUP_CLEANUP_MINIMUM_AGE_SECONDS=691200 \
  bash "${script_dir}/../cleanup-unretained-backups.sh" > "${mock_root}/invalid-marker-cleanup-preview.out"
invalid_marker_candidate_count="$(sed -n 's/^object_count=//p' "$invalid_marker_github_output")"
invalid_marker_candidate_digest="$(sed -n 's/^inventory_digest=//p' "$invalid_marker_github_output")"
assert_equal "1" "$invalid_marker_candidate_count" "old weekly object with invalid marker remains cleanup-reachable"
BACKUP_CLEANUP_SCOPE=unverified-weekly \
BACKUP_CLEANUP_MODE=delete \
BACKUP_CLEANUP_MINIMUM_AGE_SECONDS=691200 \
BACKUP_CLEANUP_EXPECTED_COUNT="$invalid_marker_candidate_count" \
BACKUP_CLEANUP_EXPECTED_DIGEST="$invalid_marker_candidate_digest" \
BACKUP_CLEANUP_CONFIRMATION='DELETE UNRETAINED BACKUPS' \
  bash "${script_dir}/../cleanup-unretained-backups.sh" > "${mock_root}/invalid-marker-cleanup-delete.out"
assert_equal "2" "$(grep --count $'^rm\t' "$FAKE_AWS_LOG")" "invalid weekly object and exact invalid marker deletion"

unset BACKUP_NOW_EPOCH FAKE_WEEKLY_FIXTURE FAKE_MARKER_FIXTURE FAKE_INVALID_MARKER_KEY

backup_workflow="${repository_root}/.github/workflows/backup-production.yml"
restore_workflow="${repository_root}/.github/workflows/restore-drill.yml"
cleanup_workflow="${repository_root}/.github/workflows/cleanup-legacy-daily-backups.yml"
unretained_cleanup_workflow="${repository_root}/.github/workflows/cleanup-unretained-backups.yml"
freshness_workflow="${repository_root}/.github/workflows/backup-freshness.yml"
backup_script="${repository_root}/.github/scripts/backup-production.sh"

grep --fixed-strings --quiet 'cron: "23 2 * * 0"' "$backup_workflow" \
  || fail "weekly workflow must run Sunday at 02:23 UTC"
grep --fixed-strings --quiet "vars.PRODUCTION_BACKUP_ENABLED == 'true'" "$backup_workflow" \
  || fail "weekly backup must require explicit production-backup enablement"
grep --fixed-strings --quiet "BACKUP_KIND: \${{ github.event_name == 'schedule' && 'weekly' || 'manual' }}" "$backup_workflow" \
  || fail "scheduled and manual backups must use separate prefixes"
grep --fixed-strings --quiet 'uses: ./.github/workflows/restore-drill.yml' "$backup_workflow" \
  || fail "every successful backup must invoke the restore workflow"
grep --fixed-strings --quiet 'restore_backup:' "$backup_workflow" \
  || fail "backup workflow must expose one restore gate for weekly and manual uploads"
grep --fixed-strings --quiet 'caller_holds_storage_lock: true' "$backup_workflow" \
  || fail "called restore must not contend with its caller's storage lock"
grep --fixed-strings --quiet "inputs.caller_holds_storage_lock && format('production-backup-restore-{0}', github.run_id) || 'production-backup-storage'" "$restore_workflow" \
  || fail "standalone restore and called restore must use non-deadlocking storage locks"
if grep --fixed-strings --quiet 'restore_weekly:' "$backup_workflow"; then
  fail "restore must not be restricted to weekly uploads"
fi
weekly_gate_count="$(grep --fixed-strings --count "needs.backup.outputs.backup_kind == 'weekly'" "$backup_workflow")"
assert_equal "1" "$weekly_gate_count" "only pruning may be restricted to weekly uploads"
grep --fixed-strings --quiet 'needs: [backup, restore_backup]' "$backup_workflow" \
  || fail "weekly pruning must depend on the shared restore gate"
grep --fixed-strings --quiet "needs.restore_backup.result == 'success'" "$backup_workflow" \
  || fail "pruning must require a successful restore"
grep --fixed-strings --quiet 'WEEKLY_BACKUP_KEEP_COUNT: "4"' "$backup_workflow" \
  || fail "weekly retention must keep four objects"
grep --fixed-strings --quiet 'RESTORE_MAX_AGE_SECONDS: "691200"' "$restore_workflow" \
  || fail "restore workflow must reject backups older than eight days"
grep --fixed-strings --quiet 'workflow_dispatch:' "$cleanup_workflow" \
  || fail "legacy daily cleanup must be explicitly dispatched"
grep --fixed-strings --quiet 'environment: production-backup-destructive' "$cleanup_workflow" \
  || fail "legacy daily deletion must require the destructive approval environment"
grep --fixed-strings --quiet 'LEGACY_DAILY_EXPECTED_DIGEST:' "$cleanup_workflow" \
  || fail "legacy daily deletion must bind the exact preview inventory digest"
grep --fixed-strings --quiet 'environment: production-backup-destructive' "$unretained_cleanup_workflow" \
  || fail "manual and unverified cleanup must require the destructive approval environment"
grep --fixed-strings --quiet 'cron: "47 6 * * *"' "$freshness_workflow" \
  || fail "independent backup freshness monitor must run daily"
grep --fixed-strings --quiet "vars.PRODUCTION_BACKUP_ENABLED == 'true'" "$freshness_workflow" \
  || fail "freshness monitor must require explicit production-backup enablement"
grep --fixed-strings --quiet 'R2_BACKUP_READ_ACCESS_KEY_ID' "$freshness_workflow" \
  || fail "freshness monitor must use its read-only credential"
grep --fixed-strings --quiet 'R2_BACKUP_WRITE_ACCESS_KEY_ID' "$backup_workflow" \
  || fail "backup upload must use its dedicated writer credential"
grep --fixed-strings --quiet 'EXPECTED_SUPABASE_PROJECT_REF: ${{ vars.EXPECTED_SUPABASE_PROJECT_REF }}' "$backup_workflow" \
  || fail "backup workflow must pin the production Supabase project independently"
grep --fixed-strings --quiet 'R2_BACKUP_RETENTION_ACCESS_KEY_ID' "$backup_workflow" \
  || fail "automatic retention must use its dedicated credential"
grep --fixed-strings --quiet 'R2_BACKUP_VERIFY_ACCESS_KEY_ID' "$restore_workflow" \
  || fail "restore marker publication must use its dedicated verifier credential"
for protected_workflow in \
  "$backup_workflow" \
  "$restore_workflow" \
  "$cleanup_workflow" \
  "$unretained_cleanup_workflow" \
  "$freshness_workflow"; do
  grep --fixed-strings --quiet "github.ref == 'refs/heads/main'" "$protected_workflow" \
    || fail "backup operations jobs must be rejected before environment selection on non-main refs"
  grep --fixed-strings --quiet 'test "$GITHUB_REF" = "refs/heads/main"' "$protected_workflow" \
    || fail "backup operations workflows must retain a runtime main-ref guard"
  grep --fixed-strings --quiet \
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262' \
    "$protected_workflow" \
    || fail "backup operations workflows must pin checkout to the reviewed commit"
  if grep --extended-regexp --quiet 'uses: actions/(checkout|setup-node)@v[0-9]+' "$protected_workflow"; then
    fail "backup operations workflows must not use mutable action version tags"
  fi
done
grep --fixed-strings --quiet \
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020' \
  "$restore_workflow" \
  || fail "restore workflow must pin setup-node to the reviewed commit"
if grep --fixed-strings --quiet 'secrets: inherit' "$backup_workflow"; then
  fail "reusable restore must not inherit unrelated caller secrets"
fi
grep --fixed-strings --quiet 'test "$GITHUB_REF" = "refs/heads/main"' "$backup_workflow" \
  || fail "production backup workflow must reject non-main refs at runtime"
grep --fixed-strings --quiet -- "--if-none-match '*'" "$backup_script" \
  || fail "new backup uploads must use an atomic create-only precondition"
grep --fixed-strings --quiet 'formatVersion: 2' "$backup_script" \
  || fail "new encrypted manifests must bind format-v2 identity fields"
grep --fixed-strings --quiet 'private.deployment_identity' "$backup_script" \
  || fail "backup creation must query the database deployment identity before snapshot export"
grep --fixed-strings --quiet 'pg_catalog.pg_stat_ssl' "$backup_script" \
  || fail "backup creation must prove the PostgreSQL session uses TLS"
if grep --fixed-strings --quiet 'prune_prefix' "$backup_script"; then
  fail "backup creation script must not prune before restore"
fi
if grep --fixed-strings --quiet 'daily_key=' "$backup_script"; then
  fail "backup creation script must not create scheduled daily objects"
fi

echo "Backup operations behavior tests passed"

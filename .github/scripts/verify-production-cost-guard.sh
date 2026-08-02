#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${R2_COST_GUARD_ACCESS_KEY_ID:?R2_COST_GUARD_ACCESS_KEY_ID is required}"
: "${R2_COST_GUARD_SECRET_ACCESS_KEY:?R2_COST_GUARD_SECRET_ACCESS_KEY is required}"

if [[ "${COST_GUARD_ENVIRONMENT:-}" != "production" ]]; then
  echo "COST_GUARD_ENVIRONMENT must be exactly production" >&2
  exit 1
fi

worker_name="meoing-cost-guard-production"
expected_domains='[{"hostname":"api-staging.meoing.com","service":"meoing-api-staging"},{"hostname":"api.meoing.com","service":"meoing-api-production"}]'

configured_secrets="$(
  npx wrangler secret list \
    --config wrangler.cost-guard.jsonc \
    --env production \
    --format json
)"
jq -e '
  ([.[] | select(.type == "secret_text") | .name] | sort)
    == ["ALERT_RECIPIENT", "CLOUDFLARE_COST_GUARD_TOKEN"]
' <<<"$configured_secrets" >/dev/null

settings="$(
  curl --silent --show-error --fail \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker_name}/settings"
)"
jq -e --arg expected_domains "$expected_domains" '
  .success == true
  and any(.result.bindings[]; .name == "STATE" and .type == "r2_bucket" and .bucket_name == "meoing-cost-guard-production")
  and any(.result.bindings[]; .name == "APP_ENV" and .type == "plain_text" and .text == "production")
  and any(.result.bindings[]; .name == "PROTECTED_CUSTOM_DOMAINS" and .type == "plain_text" and .text == $expected_domains)
  and any(.result.bindings[]; .name == "ALERT_EMAIL" and .type == "send_email" and .destination_address == "hiuudc@gmail.com")
' <<<"$settings" >/dev/null

schedules="$(
  curl --silent --show-error --fail \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker_name}/schedules"
)"
jq -e '
  .success == true
  and ([.result.schedules[].cron] == ["*/5 * * * *"])
' <<<"$schedules" >/dev/null

domains="$(
  curl --silent --show-error --fail \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains"
)"
jq -e '
  .success == true
  and ([.result[] | select(.hostname == "api-staging.meoing.com") | {hostname, service}]
    == [{"hostname":"api-staging.meoing.com","service":"meoing-api-staging"}])
  and ([.result[] | select(.hostname == "api.meoing.com") | {hostname, service}]
    == [{"hostname":"api.meoing.com","service":"meoing-api-production"}])
' <<<"$domains" >/dev/null

state_file="$(mktemp)"
cleanup() {
  rm -f -- "$state_file"
}
trap cleanup EXIT

node scripts/cost-guard-resume-r2.mjs \
  download-state \
  --output "$state_file"
[[ -f "$state_file" ]] || {
  echo "Cost Guard state download did not create a regular file" >&2
  exit 1
}
jq -e '
  .version == 1
  and .environment == "production"
  and .status == "NORMAL"
  and .stopReason == null
  and .consecutiveMetricFailures == 0
  and .detachPending == false
  and .detachedDomains == []
  and .lastUsage != null
  and ((.lastCheckedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) >= (now - 900))
' "$state_file" >/dev/null

echo "Production Cost Guard topology, schedule, secrets, and fresh NORMAL state verified"

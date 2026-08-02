# Cloudflare Cost Guard runbook

The production Cost Guard is the single account-wide controller. Every five minutes it
queries account-wide Workers and R2 analytics, persists its billing-cycle state in a private
R2 bucket, and protects both exact Meoing API custom-domain pairs:

- `api-staging.meoing.com` -> `meoing-api-staging`
- `api.meoing.com` -> `meoing-api-production`

It exports no `fetch` handler, and its Wrangler configuration disables `workers.dev`, preview
URLs, and routes in every environment. The staging environment is a temporary drill target,
not a second controller: its checked-in Cron list is empty and it may target only the staging
API pair. Never leave a staging Cron active alongside production.

## Guard envelope

The state with the highest utilization ratio controls the whole account:

| Metric | Guard limit | WARNING (80%) | STOPPED (95%) |
| --- | ---: | ---: | ---: |
| Worker requests | 1,350,000 | 1,080,000 | 1,282,500 |
| Worker CPU | 30,000,000 ms | 24,000,000 ms | 28,500,000 ms |
| R2 Class A | 1,000,000 | 800,000 | 950,000 |
| R2 Class B | 10,000,000 | 8,000,000 | 9,500,000 |
| R2 Standard storage | 10,000,000,000 bytes | 8 GB | 9.5 GB |

The request limit is intentionally much lower than the Workers Paid included 10 million
requests. It is Meoing's safe envelope, not a statement of the provider allowance. CPU and R2
limits currently match the published included/free allowances. Review the values whenever
Cloudflare pricing or the account contract changes.

`NORMAL` is below 80%, `WARNING` starts at 80%, and `STOPPED` starts at 95%. The state keeps
independent once-per-cycle markers for the account-usage warning and the analytics-unavailable
warning, plus a separate stop-notification marker. A metrics failure therefore cannot consume
the later 80% usage marker. Each attempt marker is written before calling the Email binding,
so a retry cannot duplicate that message. A rejected Email call is logged but is not retried
for that reason in the same cycle.

Three consecutive analytics failures fail closed to `STOPPED`; at a five-minute cadence this
is a 15-minute window. A successful query resets the failure counter. `STOPPED` is latched
across later low readings and across a billing-cycle rollover until the protected resume
workflow succeeds.

At STOP, only exact `(hostname, Worker service)` pairs in `PROTECTED_CUSTOM_DOMAINS` can be
detached. Wildcards, suffix matching, zone routes, Pages domains, and other Workers are never
targets. Runtime validation refuses a production configuration unless it contains exactly
both API pairs above, and refuses a staging configuration unless it contains only the staging
pair. The ordinary API Wrangler environments intentionally omit both `route` and `routes`, so
an API code deployment cannot recreate a domain that Cost Guard detached. CI and both
deployment workflows run `npm run cost-guard:deploy-boundary` to enforce that ownership
boundary. With two production domains and a direct NORMAL-to-STOPPED transition, the worst
path remains within the configured ten-subrequest limit: state read, GraphQL, domain list,
pre-effect state write, one reason-specific warning, one stop email, and two deletes (eight
subrequests; a prior STOPPED run can additionally read a resume marker). The pre-effect state
remains `detachPending` until the next idempotent Cron confirms both domains are absent.

## Account ownership and singleton preflight

Workers and R2 analytics are account-wide. Two live controllers with separate state would
make decisions from the same meter and could race or send duplicate alerts. The following is
a hard gate before any production Cron is enabled:

1. Using a separate audited read-only inventory credential, export the live Cloudflare
   account ID, Worker services/scripts, Worker custom domains, and R2 buckets. Record the UTC
   timestamp and API response/request identifiers. Store the sanitized JSON in the approved
   change record or restricted evidence store, never in this repository.
2. Reconcile every listed Worker and R2 bucket to the Meoing asset inventory. The evidence
   must explicitly show the two exact API mappings above and identify any Cost Guard state
   buckets already created. Re-run and append the inventory after creating each state bucket.
   Do not rely on the Wrangler files as evidence of live state.
3. If any non-Meoing Worker or R2 workload exists in the account, stop the rollout. Move
   Meoing to a dedicated Cloudflare account, or move the unrelated workload out, then repeat
   the live inventory. Do not compensate by raising thresholds or widening the domain
   allowlist.
4. Before cutover, confirm live schedules show zero recurring triggers for both Cost Guard
   environments. After production deployment, append evidence showing staging still has zero
   and production alone has exactly `*/5 * * * *`.

Production must not be enabled if any item above is missing or stale. Repeat the inventory
after adding a Worker, R2 bucket, custom domain, or changing the Cloudflare account boundary.

## Provider limitations

The implementation uses the current GraphQL nodes `workersInvocationsAdaptive`,
`r2OperationsAdaptiveGroups`, and `r2StorageAdaptiveGroups`. The current account schema was
verified to expose `sum.requests`, `sum.cpuTimeUs`, operation `actionType`, and storage size.
Cloudflare Analytics is delayed/adaptively sampled and is not the authoritative invoice.
R2 storage is conservatively compared as a current account-wide snapshot, whereas provider
billing is GB-month. An unknown R2 action is treated as a metric failure instead of silently
ignoring a potentially billable operation.

GraphQL R2 data is retained for 31 days and Workers queries support at most one month. The
billing anchor is therefore stored as a UTC day and must match the account subscription
renewal day. Day 29–31 anchors clamp to the final UTC day in shorter months. The configured
anchor is currently day 30, matching the live Jul 30–Aug 29, 2026 cycle; verify it again
after any subscription change.

References:

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers GraphQL metrics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)
- [R2 metrics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)
- [R2 pricing and operation classes](https://developers.cloudflare.com/r2/pricing/)
- [R2 API tokens and bucket scoping](https://developers.cloudflare.com/r2/api/tokens/)
- [R2 object tokens are S3-only](https://developers.cloudflare.com/r2/platform/troubleshooting/#object-level-api-tokens-fail-against-the-rest-api)
- [GraphQL API token authentication](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)
- [Workers custom domains API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/)
- [Email Sending binding](https://developers.cloudflare.com/email-service/email-sending/send-email/workers-binding/)

## Staging drill and singleton cutover

The checked-in default and staging configurations both have `triggers.crons: []`. Staging is
only an attended threshold drill and must never remain scheduled when production is live.
Complete the account-ownership preflight above before the drill.

1. Create the dedicated staging state bucket. Do not expose it through a custom domain or
   `r2.dev`.

   ```powershell
   npx wrangler r2 bucket create meoing-cost-guard-staging
   ```

2. Verify `hiuudc@gmail.com` in Cloudflare Email Routing and confirm that
   `no-reply@auth.meoing.com` is an allowed sender. The staging and production
   `ALERT_EMAIL` bindings lock both `destination_address` and `allowed_sender_addresses`, so
   Cloudflare rejects attempts to send anywhere else. Set the encrypted `ALERT_RECIPIENT`
   secret to that same address.

3. Create a dedicated runtime API token, scoped to the Meoing Cloudflare account, with only:

   - Account Analytics: Read, for GraphQL Workers/R2 metrics.
   - Workers Scripts: Edit, for list/detach/attach of account custom domains.

   Store it only as an encrypted Worker secret. Never put it in `.dev.vars`, Wrangler JSON,
   GitHub logs, or a repository secret intended for another Worker.

   ```powershell
   npx wrangler secret put CLOUDFLARE_COST_GUARD_TOKEN --config wrangler.cost-guard.jsonc --env staging
   npx wrangler secret put ALERT_RECIPIENT --config wrangler.cost-guard.jsonc --env staging
   ```

4. Confirm the exact live staging mapping is `api-staging.meoing.com` to
   `meoing-api-staging`. A mismatch is a hard failure, not an invitation to broaden the
   allowlist. Bootstrap this mapping once through an audited Custom Domains change. Do not
   add it to `wrangler.api.jsonc`.

5. Generate types, run the local gates, and deploy the inactive staging Worker. Confirm the
   deploy reports no Cron trigger.

   ```powershell
   npm run types
   npm run typecheck
   npm run lint
   npm run test -- --run test/cost-guard.test.ts
   npm run cost-guard:deploy-boundary
   npx wrangler deploy --dry-run --config wrangler.cost-guard.jsonc --env staging
   npx wrangler deploy --config wrangler.cost-guard.jsonc --env staging
   npx wrangler secret list --config wrangler.cost-guard.jsonc --env staging
   ```

6. Run one attended fake-low-threshold drill before production has any Cron. First capture a
   fresh account metric snapshot and confirm real usage is below 5% of the checked-in limits;
   otherwise the protected resume workflow will correctly refuse the drill resume.

   - For the warning stage, choose a temporary request limit that puts the current request
     count between 80% and 95%. Deploy with a CLI `--var` override, then temporarily attach
     the five-minute staging schedule:

     ```powershell
     npx wrangler deploy --config wrangler.cost-guard.jsonc --env staging --var "WORKERS_REQUEST_GUARD_LIMIT:<warning-drill-limit>"
     npx wrangler triggers deploy --config wrangler.cost-guard.jsonc --env staging --schedule "*/5 * * * *"
     ```

     Capture the `usage_threshold` warning event and delivered email, and prove the staging
     domain remains attached.

   - For the stop stage, lower only that temporary limit so the same account snapshot is at
     least 95%, redeploy, and re-apply the temporary schedule. Capture the STOP event, state,
     and live custom-domain inventory proving that only the staging pair was detached.

     ```powershell
     npx wrangler deploy --config wrangler.cost-guard.jsonc --env staging --var "WORKERS_REQUEST_GUARD_LIMIT:<stop-drill-limit>"
     npx wrangler triggers deploy --config wrangler.cost-guard.jsonc --env staging --schedule "*/5 * * * *"
     ```

   - Let one more scheduled invocation run. Prove idempotency: no duplicate warning/STOP
     email, no unrelated domain mutation, and persisted `detachPending` becomes `false` after
     the controller confirms the staging domain is absent.

   - Dispatch **Resume Cloudflare Cost Guard** for `staging` with the exact confirmation.
     Immediately redeploy the checked-in staging configuration without any `--var` override,
     then temporarily re-apply the schedule so the next invocation evaluates the marker with
     the real limits and performs the manual, approved resume. Capture `cost_guard_resumed`
     and the restored exact staging mapping.

7. Disable the staging Cron immediately after the resume. Deploy the checked-in configuration
   again and apply its empty trigger set. Verify the live schedule inventory is empty; do not
   rely only on command success.

   ```powershell
   npx wrangler deploy --config wrangler.cost-guard.jsonc --env staging
   npx wrangler triggers deploy --config wrangler.cost-guard.jsonc --env staging
   ```

   Save the warning, detach, second-run idempotency, approved resume, restored-domain, default
   limits, and empty-schedule evidence in the restricted change record. If the staging Cron
   cannot be proven absent, do not enable production.

8. Create the production state bucket and secrets, then repeat the dry-run gates for
   `--env production`. Re-run the live account inventory. Production configuration must show
   exactly both API domain pairs and the only recurring Cost Guard schedule.

   ```powershell
   npx wrangler r2 bucket create meoing-cost-guard-production
   npx wrangler secret put CLOUDFLARE_COST_GUARD_TOKEN --config wrangler.cost-guard.jsonc --env production
   npx wrangler secret put ALERT_RECIPIENT --config wrangler.cost-guard.jsonc --env production
   npx wrangler deploy --dry-run --config wrangler.cost-guard.jsonc --env production
   npx wrangler deploy --config wrangler.cost-guard.jsonc --env production
   ```

This repository does not automatically deploy Cost Guard from the ordinary API deployment
workflow, so these evidence gates remain an explicit operator responsibility.

## Alerts and incident response

Watch structured events:

- `cost_guard_checked`: valid NORMAL/WARNING reading.
- `cost_guard_metrics_failed`: one failed account metric query.
- `cost_guard_notification_sent`: accepted Email binding call. `notificationKind` is
  `usage_threshold`, `metrics_unavailable`, or `stop`, each with its own cycle marker.
- `cost_guard_notification_failed`: Email binding rejected that reason-specific cycle
  attempt; investigate the verified destination and sender immediately.
- `cost_guard_stopped`: strict allowlist enforcement completed.
- `cost_guard_resume_claimed`: the approved marker won the R2 state CAS before any attach.
- `cost_guard_resume_claim_recovered`: an expired in-progress lease was reclaimed after a
  crash; the attach pass remains idempotent.
- `cost_guard_resume_in_progress`: an overlapping Cron observed an active claim and made no
  domain or state mutation.
- `cost_guard_resume_rejected`: marker was stale, mismatched, or usage was not below 5%.
- `cost_guard_resumed`: custom domain was restored and state returned to NORMAL.
- `cost_guard_failed`: scheduled invocation failed; inspect the preceding sanitized event.

Never manually widen `PROTECTED_CUSTOM_DOMAINS` during an incident. If either API domain was
manually reattached while production state remains STOPPED, the next Cron will detach it
again.

## Approved resume

Use **Resume Cloudflare Cost Guard** from GitHub Actions. In steady state, select
`production`: that marker goes to the singleton controller bucket and an approved resume
restores whichever of the two exact API domains are missing. The `staging` option is only for
the attended drill above while its temporary Cron is still active; never queue a staging
marker after the staging Cron has been disabled. Do not attach either domain directly in the
Cloudflare dashboard.

Create exactly two GitHub environments, `cost-guard-resume-staging` and
`cost-guard-resume-production`. Restrict both to `main`. Enable required reviewers when the
repository plan exposes that control. If the plan does not support required reviewers for
this private repository, record that limitation: the main-only guard, exact typed
confirmation, and environment isolation remain mandatory but are not a substitute for a
second-person production approval. Production acceptance then requires a supported GitHub
plan, an approved external deployment gate, or an explicit security-risk acceptance.

Each environment has the same names but distinct environment-specific values:

- Environment variable `CLOUDFLARE_ACCOUNT_ID`, set to the exact Meoing account ID. It is not
  a secret.
- Secret `CLOUDFLARE_COST_GUARD_ANALYTICS_TOKEN`, scoped only to Account Analytics Read for
  the Meoing account. Prefer a distinct token per environment for independent rotation and
  audit evidence.
- Secrets `R2_COST_GUARD_ACCESS_KEY_ID` and `R2_COST_GUARD_SECRET_ACCESS_KEY`, created from an
  R2 Object Read & Write token restricted to exactly one bucket:
  `meoing-cost-guard-staging` or `meoing-cost-guard-production`, matching the GitHub
  environment.

R2 object credentials authenticate only through the S3-compatible endpoint with SigV4,
region `auto`. Do not map them to `CLOUDFLARE_API_TOKEN` or use `wrangler r2 object --remote`:
Cloudflare's native REST API does not accept bucket-scoped object tokens and would require
broader account-level R2 authority. Bucket and object keys are fixed in the checked-in helper;
they are never workflow inputs or secrets.

The protected production release workflow uses another bucket-scoped S3 credential with
Object Read-only access to `meoing-cost-guard-production`. It calls the same fixed-key helper
to prove a fresh NORMAL state both before the first production mutation and after smoke. It
must not expose the read/write resume credential, write the state object, use native Wrangler
R2 object access, or turn that read into a resume path.

The workflow exposes the R2 pair only to the state-download and marker-upload steps. The
GraphQL recheck receives only the Analytics Read token. Checkout, Node setup, confirmation,
and dependency installation receive no provider secret. Third-party Actions are pinned to
verified full commit SHAs. Dispatches from refs other than `refs/heads/main` are rejected,
checkout uses the exact dispatch commit SHA, and the choice input selects one of the two
protected GitHub environments.

### Resume credential cutover

The staging state bucket already exists in the default jurisdiction. Provision staging first.
The production state bucket is not yet present in the current inventory; create
`meoing-cost-guard-production` in the default jurisdiction before provisioning or testing
production credentials. Source support for production does not authorize enabling its Cron.

For each environment, record sanitized token identifiers, permission policies, timestamps,
and results in the restricted change record, never secret values. The following permission
matrix is a hard gate:

| Credential | Must succeed | Must be denied |
| --- | --- | --- |
| Analytics token | The checked-in GraphQL Workers/R2 metrics query | Native R2 object REST; Workers Scripts and custom-domain mutation |
| Staging R2 pair | S3 SigV4 GET/PUT/HEAD/DELETE of a unique canary in `meoing-cost-guard-staging` | Every production, asset, and backup bucket; bucket creation/deletion |
| Production R2 pair | S3 SigV4 GET/PUT/HEAD/DELETE of a unique canary in `meoing-cost-guard-production` | Every staging, asset, and backup bucket; bucket creation/deletion |

Delete each credential-test canary and verify HEAD returns 404. Any cross-bucket success is a
stop condition. A missing/wrong credential, bad signature, wrong account/jurisdiction,
malformed or non-STOPPED state, state from the other environment, existing resume claim, or
usage at or above 5% must write no marker and must leave domains detached.

Run the full attended staging STOP, marker, Cron resume, and idempotency drill before
production. Prove only the staging domain changed and prove the staging schedule is empty
afterward. Once the new source is deployed and every currently live environment has passed,
revoke the Cloudflare token behind the legacy `CLOUDFLARE_COST_GUARD_RESUME_TOKEN`, delete
that GitHub secret, and delete or empty the legacy `cost-guard-resume` environment. The live
resume workflow and runtime scripts must contain neither that secret name nor a native
Wrangler R2 object command. Verifier code, negative-test fixtures, and this deprecation note
may retain those strings solely to reject their reintroduction.

Do not retain a dormant broad R2 fallback. Before revocation, rollback may restore the prior
workflow only as an attended temporary measure while the legacy protected environment remains
inaccessible to untrusted code. After revocation, leave the controller STOPPED and fix
forward. If recovery cannot wait, the account owner may issue a short-lived account-scoped
credential for one attended incident, then revoke it immediately and record the exception.

The workflow requires the exact typed confirmation, downloads STOPPED state, independently
rechecks all five account metrics, and refuses unless the highest utilization is strictly
below 5%. It writes a one-shot resume marker to R2. On the next Cron, the Worker rechecks
usage below 5% and accepts only a canonical UTC marker timestamp that is after the current
`stoppedAt`, no more than 15 minutes old, bound to that exact stop timestamp, and associated
with a workflow run ID not already consumed in the cycle. Before any domain side effect it
wins an ETag-conditional R2 write of a
durable resume claim. Overlapping Crons therefore stop before attach. The claim has a
four-minute lease: after a crash, the next five-minute Cron can reclaim it, verify every stored
domain against the strict allowlist, and idempotently attach only missing domains. The final
ETag-conditional write changes state to NORMAL and consumes the workflow run ID; a leftover
marker cannot resume a later STOP and is deleted opportunistically.

If the workflow succeeds but no `cost_guard_resumed` event appears within ten minutes, do not
retry blindly. Inspect the scheduled Worker logs, state bucket, exact domain mapping, and API
token permission first.

# Deployment runbook

## Environments

Use three isolated environments:

- local: Supabase CLI stack, Wrangler local bindings and Mailpit;
- staging: separate Supabase project, Hyperdrive configuration, R2 bucket,
  Worker names, OAuth callbacks and Turnstile keys;
- production: separate resources and GitHub environment approval.

Never point a staging Worker at the production database or bucket.

## Staging deployment gate

The public repository keeps `Deploy staging` disabled by default. Its job runs
only after a successful trusted push to `main` and the repository variable
`STAGING_DEPLOY_ENABLED` is exactly `true`. This prevents placeholder
infrastructure configuration or an incomplete credential rotation from
producing a failed deployment on every CI run.

Enable the variable only after the staging environment has a scoped, working
`CLOUDFLARE_API_TOKEN`, a matching `CLOUDFLARE_ACCOUNT_ID`, all required Worker
secrets, and the reviewed staging database and resource bindings. Remove the
variable or set it to `false` again before rotating those prerequisites.

## Required secrets

API Worker:

- Supabase project URL (the Worker derives `/.well-known/jwks.json`)
- R2 S3 access key ID and secret access key for signing URLs
- invite-token/abuse HMAC secret and Turnstile secret

Maintenance Worker:

- environment-specific Supabase Auth Admin `sb_secret_*` key, stored only as
  the encrypted `SUPABASE_SECRET_KEY` Worker binding
- maintenance database credentials stored in its Hyperdrive configuration

GitHub environments:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_PROJECT_REF`
- `SUPABASE_DB_PASSWORD`

Production additionally requires:

- `CLOUDFLARE_R2_CORS_TOKEN`
- `R2_COST_GUARD_STATE_READ_ACCESS_KEY_ID`
- `R2_COST_GUARD_STATE_READ_SECRET_ACCESS_KEY`

The production `CLOUDFLARE_API_TOKEN` is an ordinary release credential, not a
domain-operator or Cost Guard runtime credential. Scope it to this Meoing account
and only the capabilities exercised by the checked-in workflow:

- deploy and inspect the three existing Worker services, including their secret
  names, settings and schedules;
- deploy the existing production Pages project;
- read the Workers custom-domain inventory used by the release gate.

Do not grant DNS edit, zone administration, billing edit, account administration,
database access, or permission to attach/detach Worker routes or custom domains.
Where Cloudflare combines a needed capability with a
broader edit permission, record that limitation and validate operationally that
the release workflow contains no domain mutation; the separate domain operator
and Cost Guard tokens remain the only credentials used for domain changes. Before
storing the token in GitHub, run positive canaries for the operations above and
negative canaries for custom-domain mutation. Re-run the canaries after every
permission change or rotation.

Store `CLOUDFLARE_R2_CORS_TOKEN` separately in the production GitHub environment.
It is exposed only to the exact apply/read-back step for
`meoing-files-production`. Scope it to R2 configuration edit on the Meoing
account and grant no Workers, Pages, DNS, billing or account-administration
permissions. If Cloudflare cannot restrict R2 configuration authority to one
bucket, record the resulting account-wide R2 configuration/deletion capability
as a provider limitation, keep the token out of every other step, and verify the
workflow's static boundary before each release. Never reuse this token for R2
object access or backup retention.

The production GitHub environment also stores
`R2_COST_GUARD_STATE_READ_ACCESS_KEY_ID` and
`R2_COST_GUARD_STATE_READ_SECRET_ACCESS_KEY`. Create this as a separate R2 S3
Object Read-only credential restricted to exactly
`meoing-cost-guard-production`; it is not the read/write resume credential. The
release workflow maps it to the fixed S3 helper only while downloading
`cost-guard/state.json`. Its positive canary must read that object, while reads
from every other state, asset and backup bucket must fail. This keeps the
ordinary Cloudflare API token free of account-wide R2 object-read authority.

The protected production environment must also define the non-secret
`EXPECTED_SUPABASE_PROJECT_REF` variable. It is an independently administered
deployment pin: the workflow compares it with the secret before `supabase link`
or `db push`, then uses it again for marker verification and the final health
smoke. Staging has the reviewed project ref pinned directly in its workflow and
performs the same pre-migration comparison. Keep other non-secret origins,
project URLs, account IDs and bucket names in Wrangler environment
configuration. Store no credential in the repository.

The maintenance Wrangler configuration declares `SUPABASE_SECRET_KEY` as
required for every environment. Both deployment workflows list the remote
secret binding before changing the database, and every scheduled run validates
the key format plus read-only Auth Admin access before cleanup. Bootstrap the
Worker and install this secret before enabling a new environment's deployment
workflow. After deployment or rotation, wait for a `maintenance_complete`
event; do not revoke the previous key until that canary succeeds. The API
Worker must never receive this key.

Supabase Auth transactional email uses Cloudflare Email Sending's SMTP
submission endpoint. Onboard the environment's sending subdomain, verify its
Cloudflare-managed SPF, DKIM, bounce MX and DMARC records, then configure:

- host `smtp.mx.cloudflare.net`;
- port `465` with implicit TLS;
- username `api_token`;
- an account-owned Cloudflare API token with only `Email Sending: Edit`;
- the environment-specific sender address and name.

Store the SMTP token only in Supabase Auth's encrypted custom-SMTP settings.
Do not put it in a Worker secret, GitHub environment, local env file or CI log.
Use a dedicated token and record its owner, creation date and rotation/revocation
procedure. `Email Sending: Edit` applies to every onboarded sending domain in
the selected Cloudflare account; Cloudflare cannot narrow this SMTP credential
to only one sending subdomain, so never reuse it for another integration.

Arbitrary-recipient delivery requires Workers Paid. Before promotion, inspect
the account's current daily Email Sending quota and monthly usage (Workers Paid
currently includes 3,000 emails per account per month), then set Supabase Auth's
email rate limit no higher than the provider capacity. Enabling custom SMTP sets
the hosted Supabase project to 30 Auth emails/hour by default; review that value
deliberately instead of assuming it matches Cloudflare's dynamic daily quota.

Disable Cloudflare **Email preview** before any real Auth email is sent.
New sending domains enable it automatically and otherwise retain message
content, including live verification/reset links, for about seven days. Use
delivery/authentication metadata logs for routine operations.

Cloudflare Email Sending is currently beta, so verify signup confirmation and
password recovery in staging, inspect delivery logs, and retain the previous
provider credential until the canary succeeds. Afterward, inventory and remove
the previous provider's sender-verification, DKIM, tracking/bounce and DMARC
records so the sending subdomain authorizes only Cloudflare.

## Edge and database perimeter

- Create each Hyperdrive configuration with query caching disabled. Every API
  response depends on the transaction-local actor and collection permissions.
- Use a dedicated `meoing_api_login` database login for API Hyperdrive and a
  separate `meoing_maintenance_login` for the Cron Worker; never connect either
  Worker as `postgres`. Both login roles must be `NOINHERIT`, `NOBYPASSRLS`,
  use `pg_catalog` as their role-level `search_path`, and receive their
  capability-role membership with `INHERIT FALSE, SET TRUE`.
- Cap the API Hyperdrive origin pool at 20 connections and
  `meoing_api_login` at 25. Cap the maintenance pool at 5 and
  `meoing_maintenance_login` at 8. Re-check these four limits together before
  raising any one of them so Supabase's platform services retain headroom.
- After migrations and before routing a new or restored environment, configure
  its singleton `private.deployment_identity` row with `staging` or
  `production` and the exact 20-character Supabase project ref. The migration
  never guesses this environment-specific value. Both deployment workflows run
  `npm run db:target:verify` before linking or migrating, so a drifted project
  secret cannot select the migration target. They then run
  `npm run db:identity:configure` through the Supabase Management API using two
  sequential statements: an idempotent fail-closed insert/confirmation and a
  post-commit assertion. This supports a genuinely empty hosted database while
  refusing to replace a different marker. Readiness and every API or
  maintenance transaction fail before application access/cleanup when the
  marker does not match the Worker and Hyperdrive target.
- Keep the R2 application and backup buckets private and apply the committed R2
  CORS allowlist only to the application bucket.
- Enable Cloudflare managed WAF rules for the API hostname and retain the
  platform's automatic DDoS protection. Validate strict CORS and the configured
  Turnstile flows in staging before promotion.

## Release order

1. Run frontend and backend CI, including local database tests.
2. Apply additive/backward-compatible database migrations.
3. Deploy the API Worker.
4. Deploy the maintenance Worker.
5. Deploy the website and API contract changes.
6. Run health/auth/R2 smoke tests, verify the maintenance canary, and watch
   Worker errors, PostgreSQL locks/connections and R2 failures.

After staging deployment, run the manual **Staging acceptance and load gate**
workflow described in [acceptance.md](acceptance.md). A health-only deployment
smoke does not replace the credentialed vertical slice or the 100-user load
gate.

Configure and review the sampled database signals and provider-side 70%/85%
quota alerts described in [observability.md](observability.md). The repository
does not claim those provider alerts exist until their dashboard configuration
and notification test have been recorded.

## One-time production hostname and Pages bootstrap

The ordinary production workflow assumes that the production Worker service, API custom
domain and Pages project already exist. This section is the one-time bootstrap for a new
production environment. It is not a recurring release path and it must not weaken the
route-free deployment boundary enforced by `npm run cost-guard:deploy-boundary`.

This is an attended manual operator procedure; the repository intentionally has no reusable
`production-bootstrap` workflow that could retain domain-attachment authority. Record the
user's explicit production approval and keep two credentials separate at the command/session
boundary:

- the ordinary deploy credential is exposed only to the route-free Worker/Pages deployment
  and release-verification steps described above and must not be used to create, attach or
  restore a Worker route or custom domain;
- a dedicated, short-lived domain operator credential is exposed only to the exact custom
  domain inventory and attach steps. Do not expose it to checkout, dependency installation,
  builds, migrations or ordinary Worker deployment. If Cloudflare cannot narrow the token to
  one hostname, retain an exact before/after inventory and revoke the token immediately after
  bootstrap.

The bootstrap must use one exact 40-character commit SHA that is reachable from `main` and
has a successful `push` CI run. Checkout that SHA detached and use it for every build and
deployment below; do not rebuild from a moving branch tip.

1. Provision the private production R2 bucket and both cache-disabled Hyperdrive
   configurations. Replace the reviewed production placeholders in the Wrangler files, then
   apply [`../../backend/config/r2-cors.production.json`](../../backend/config/r2-cors.production.json)
   to `meoing-files-production` and verify `r2.dev` plus R2 custom domains remain disabled.
2. Create the production Pages project once, with `main` as its production branch, and set
   the protected `CLOUDFLARE_PAGES_PROJECT` variable to that exact project name. Do not reuse
   the staging project. Reserve `meoing.com` for this project; attach it after the first
   same-SHA Pages deployment and verify the active certificate and proxied DNS record.
3. Before any hosted migration or Worker deploy, query the live secret inventory with
   `wrangler secret list --format json` and confirm all four API secrets exist on
   `meoing-api-production` and `SUPABASE_SECRET_KEY` exists on
   `meoing-maintenance-production`. The maintenance key must be an environment-specific
   `sb_secret_...` value and must pass the Auth Admin canary. A missing binding is a stop
   condition, not a reason to put a credential in Wrangler vars. Wrangler's
   `secrets.required` declaration documents/typechecks the binding shape; it is not accepted
   as proof of live secret presence.
4. Run the production database target check, apply migrations, and configure the exact
   deployment identity. From the detached release SHA, deploy the API Worker with only:

   ```powershell
   npx wrangler deploy --config wrangler.api.jsonc --env production
   ```

   Do not pass `--route`, `--routes`, or a trigger override, and do not add `route`/`routes`
   to any API Wrangler environment. Verify the resulting service is exactly
   `meoing-api-production`, with `workers.dev` and preview URLs disabled, before attaching a
   public hostname.
5. In the separately authorized domain-operator step, obtain a fresh live custom-domain
   inventory, require that `api.meoing.com` is absent, and attach exactly this pair through
   the Workers Custom Domains API:

   ```text
   api.meoing.com -> meoing-api-production
   ```

   Reject an existing hostname mapped to any other service. Re-read the provider inventory
   and require exactly one matching pair, no unexpected production API route, and both
   `workers.dev` and preview URLs still disabled. Record sanitized request IDs, timestamps and
   the before/after mapping in the restricted change record.
6. Deploy the maintenance Worker and the first Pages build from the same release SHA. Attach
   `meoing.com` to the production Pages project, verify its certificate/DNS, and confirm the
   frontend origin exactly matches the API and R2 CORS allowlists.
7. Complete every production gate in [cost-guard.md](cost-guard.md): preserve the attended
   staging warning/STOP/idempotent-resume evidence, create the production state bucket and
   two live secrets, deploy `meoing-cost-guard-production`, and verify the live Cron is
   exactly `*/5 * * * *`, its topology contains exactly the staging and production API
   mappings, and a scheduled `cost_guard_checked` run writes a fresh NORMAL state. The
   ordinary API workflow deliberately does not deploy the controller, but it does fail unless
   this exact live topology, Cron and fresh state are present. Install the separate read-only
   production state credential described above before enabling the release workflow.
8. Dispatch the canonical **Deploy production** workflow with that same SHA. Its API deploy
   remains route-free and first runs a fresh Cost Guard preflight before any production
   mutation. It then preserves the audited custom-domain mapping, reapplies and reads back
   exact R2 CORS only after all local tests pass, redeploys Pages, proves `meoing.com` serves
   that release SHA, and repeats the live Cost Guard check as a postflight. A different SHA
   or a changed domain inventory requires a new reviewed bootstrap attempt.
9. Run the credentialed production acceptance in [acceptance.md](acceptance.md). It must use
   canary accounts to prove production Turnstile signup/recovery, invite preview/acceptance,
   an R2 upload/finalize/download cycle against `meoing-files-production`, and denial of a
   cross-owner asset. Secret-name inventory and `/health/*` do not validate secret values.
   Delete the marked canaries and their assets after the checks. A green deployment workflow
   alone is not production acceptance.
10. Revoke the short-lived bootstrap domain credential. After the production Cost Guard owns
   both API mappings, never use this procedure to bypass a STOPPED state or manually reattach
   a detached domain; only the approved Cost Guard resume workflow may restore it.

Production deployment is manual through the protected GitHub `production`
environment. If the API release fails, roll back the Worker version. Database
migrations are forward-only; write a corrective migration instead of mutating
applied migration files.

The initial infrastructure bootstrap is the one recorded exception in Git
history: five draft baseline files were retimestamped before any shared
database applied them.

| Never-applied draft | Immutable replacement |
| --- | --- |
| `20260730110513_initial_schema` | `20260731023925_initial_schema` |
| `20260730110520_security_and_rls` | `20260731023945_security_and_rls` |
| `20260730110525_api_rpcs` | `20260731024212_api_rpcs` |
| `20260730110530_maintenance` | `20260731024237_maintenance` |
| `20260730110535_operational_observability` | `20260731024243_operational_observability` |

The staging migration ledger was verified to contain only the replacements,
each replacement was byte-identical to its draft, and no production database
existed at that cutover. Treat the replacement baseline as immutable. If an
untracked database reports any draft version, stop rather than running
migrations and reconcile its ledger and schema manually first.

## Smoke test

- `/health/live` responds without a database query.
- `/health/ready` reaches PostgreSQL through Hyperdrive and returns the exact
  database environment/project marker.
- a forged or expired JWT is rejected.
- a verified account can complete username onboarding.
- create/list/update a collection and unit.
- a stale unit revision returns `REVISION_CONFLICT`.
- upload initialization, R2 PUT, finalize and authorized download succeed.
- a progress batch retry returns the previous result without double counting.
- direct PostgREST access to the `app` schema is denied.

The automated form of these checks, its required staging identities and the
latency/error thresholds are documented in [acceptance.md](acceptance.md).

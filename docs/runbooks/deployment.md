# Deployment runbook

## Environments

Use three isolated environments:

- local: Supabase CLI stack, Wrangler local bindings and Mailpit;
- staging: separate Supabase project, Hyperdrive configuration, R2 bucket,
  Worker names, OAuth callbacks and Turnstile keys;
- production: separate resources and GitHub environment approval.

Never point a staging Worker at the production database or bucket.

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
5. Deploy the web application and extension contract changes.
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

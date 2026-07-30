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

- Supabase Auth Admin secret
- maintenance database credentials stored in its Hyperdrive configuration

GitHub environments:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_PROJECT_REF`
- `SUPABASE_DB_PASSWORD`

Keep non-secret origins, project URLs, account IDs and bucket names in Wrangler
environment configuration. Store no credential in the repository.

## Edge and database perimeter

- Create each Hyperdrive configuration with query caching disabled. Every API
  response depends on the transaction-local actor and collection permissions.
- Use a dedicated `meoing_api_login` database login for API Hyperdrive and a
  separate `meoing_maintenance_login` for the Cron Worker; never connect either
  Worker as `postgres`.
- Keep the R2 application and backup buckets private and apply the committed R2
  CORS allowlist only to the application bucket.
- Enable Cloudflare managed WAF rules for the API hostname and retain the
  platform's automatic DDoS protection. Validate strict CORS and the configured
  Turnstile flows in staging before promotion.

## Release order

1. Run frontend and backend CI, including local database tests.
2. Apply additive/backward-compatible database migrations.
3. Deploy the maintenance Worker.
4. Deploy the API Worker and run health/auth/R2 smoke tests.
5. Deploy the web application and extension contract changes.
6. Watch Worker errors, PostgreSQL locks/connections and R2 failures.

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

## Smoke test

- `/health/live` responds without a database query.
- `/health/ready` reaches PostgreSQL through Hyperdrive.
- a forged or expired JWT is rejected.
- a verified account can complete username onboarding.
- create/list/update a collection and unit.
- a stale unit revision returns `REVISION_CONFLICT`.
- upload initialization, R2 PUT, finalize and authorized download succeed.
- a progress batch retry returns the previous result without double counting.
- direct PostgREST access to the `app` schema is denied.

The automated form of these checks, its required staging identities and the
latency/error thresholds are documented in [acceptance.md](acceptance.md).

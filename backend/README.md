# Meoing backend

Cloudflare Workers API for Meoing. The API is the only application-data entry point. It
verifies Supabase access tokens, executes PostgreSQL RPCs through Hyperdrive, and issues
short-lived URLs for a private R2 bucket.

## Runtime shape

- `src/api-worker.ts`: public Hono API, OpenAPI 3.1 at `/openapi.json`.
- `src/maintenance-worker.ts`: Cron-only retention and deletion worker; it exports no HTTP
  handler.
- `src/cost-guard-worker.ts`: five-minute Cron-only account usage guard; it persists state in
  R2 and can detach only the exact allowlisted API custom domain at the stop threshold.
- `src/db/repository.ts`: one short PostgreSQL transaction per API operation. Every
  transaction uses `SET LOCAL ROLE meoing_runtime` and
  `set_config('app.user_id', <verified JWT sub>, true)`.
- `src/storage/r2.ts`: private, direct-to-R2 uploads with signed content type and SHA-256,
  followed by size, stored checksum, and magic-byte verification.
- `supabase/`: handwritten SQL migrations and pgTAP tests.

Application responses use:

```json
{ "data": {}, "meta": {} }
```

Errors use:

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "The unit changed",
    "requestId": "..."
  }
}
```

All wire fields are camelCase. PostgreSQL RPCs are
`private.api_<operation>(p_input jsonb) returns jsonb`; maintenance calls
`private.maintenance_cleanup(p_input jsonb)` followed by
`private.maintenance_finalize(p_input jsonb)` only after external R2 and Supabase Auth
deletion succeeds. Failed external deletion leaves the candidate eligible for the next Cron.

## Prerequisites

- Node.js 22
- Docker-compatible runtime for local Supabase
- Wrangler login
- A Supabase project using an asymmetric Auth signing key (ES256 or RS256)
- A Cloudflare Hyperdrive configuration with query caching disabled
- A private R2 bucket and R2 S3 API credentials scoped to that bucket

Install and verify:

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
Copy-Item .dev.vars.maintenance.example .dev.vars.maintenance
Copy-Item .dev.vars.cost-guard.example .dev.vars.cost-guard
npm run auth:key:local
npm run types
npm run check
```

`npm run db:start` runs `auth:key:local` automatically. It creates the ignored
`supabase/signing_keys.json` file with an ES256 key, matching the asymmetric JWKS flow used
by staging and production. Do not commit that private key.

Set a local PostgreSQL connection for Hyperdrive emulation before `npm run dev`:

```powershell
$env:CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = "postgresql://..."
npm run dev
```

Never commit `.dev.vars`. `INVITE_TOKEN_SECRET` must be at least 32 random bytes. It
deterministically derives an invite token from the authenticated actor, collection, and
idempotency key, so a safe retry returns the same raw token while PostgreSQL receives only
its SHA-256 hash.

## Cloud configuration

Replace all project, account, Hyperdrive, bucket, and origin placeholders in the
three `wrangler.*.jsonc` files. Resource bindings and variables are deliberately repeated for
`staging` and `production` because Wrangler environments do not inherit them.

Set API Worker secrets independently for each environment:

```powershell
npx wrangler secret put R2_ACCESS_KEY_ID --config wrangler.api.jsonc --env staging
npx wrangler secret put R2_SECRET_ACCESS_KEY --config wrangler.api.jsonc --env staging
npx wrangler secret put INVITE_TOKEN_SECRET --config wrangler.api.jsonc --env staging
npx wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.api.jsonc --env staging
```

Set only the Auth administration secret on the maintenance Worker:

```powershell
npx wrangler secret put SUPABASE_SECRET_KEY --config wrangler.maintenance.jsonc --env staging
```

The Cost Guard uses a separate account token with Account Analytics Read and Workers Scripts
Edit. Store it only on that Worker:

```powershell
npx wrangler secret put CLOUDFLARE_COST_GUARD_TOKEN --config wrangler.cost-guard.jsonc --env staging
npx wrangler secret put ALERT_RECIPIENT --config wrangler.cost-guard.jsonc --env staging
```

Repeat with `--env production`. Use a dedicated `sb_secret_...` key for each environment.
The maintenance Wrangler configuration declares this binding as required, so deploy fails
closed when it is absent. Every scheduled run also checks the `sb_secret_` format and makes
a read-only Supabase Auth Admin canary request before cleanup. Confirm a
`maintenance_complete` event after secret rotation before revoking the previous key. The API
Worker must never receive a Supabase secret key.

Apply [config/r2-cors.example.json](config/r2-cors.example.json) to each R2 bucket after
replacing its origins. Uploads must use the exact `content-length`, `content-type`, and
`x-amz-checksum-sha256` values returned by `POST /v1/files/uploads`; all three are part
of the R2 PUT signature so changing the declared byte length invalidates the URL.

Configure Turnstile in Supabase Auth for signup/password recovery. The API additionally
requires `x-turnstile-token` for invite preview and acceptance. Configure Google OAuth,
email confirmation, redirect URLs, and Cloudflare Email Sending SMTP in the Supabase
dashboard. Onboard the sending subdomain in Cloudflare first, then use
`smtp.mx.cloudflare.net:465`, username `api_token`, and an account-owned API token scoped
only to `Email Sending: Edit`. Keep that token only in Supabase Auth; none of those
credentials belong in this package. Cloudflare manages the sending subdomain's SPF,
DKIM, bounce MX, and DMARC records.

The Hyperdrive origin login role must be granted `meoing_runtime`; the maintenance origin
login must be granted `meoing_maintenance`. Neither capability role may own tables or have
`BYPASSRLS`. Keep the `app` schema out of the Supabase Data API exposed schemas and revoke
application-table access from `anon` and `authenticated`.

## Commands

```powershell
npm run dev
npm run dev:maintenance
npm run dev:cost-guard
npm run db:start
npm run db:reset
npm run db:test
npm run db:concurrency
npm run db:target:verify
npm run db:identity:configure
npm run db:stop
npm run acceptance:check
npm run acceptance:provision
npm run acceptance:staging
npm run acceptance:load
npm run typecheck
npm run lint
npm run test
npm run build
npm run check
npm run openapi:types
```

`db:target:verify` requires `MEOING_DATABASE_ENVIRONMENT`,
`MEOING_EXPECTED_SUPABASE_PROJECT_REF`, and `SUPABASE_PROJECT_REF`. Run it
before `supabase link` or `db push`; it makes no network request and fails
unless the independently pinned ref and deployment target match exactly.
`db:identity:configure` requires the same three values plus
`SUPABASE_ACCESS_TOKEN`.

`db:concurrency` requires `DATABASE_URL`. It opens two independent runtime
transactions against one `maxUses=1` invite and fails unless exactly one
redemption succeeds, the other returns `INVITE_INVALID`, and `uses_count`
remains `1`. The harness uses random identities and removes its rows afterward.

`npm run build` performs three Wrangler dry-runs and does not deploy. Deployments are
intentional, separate operations:

```powershell
npx wrangler deploy --config wrangler.api.jsonc --env staging
npx wrangler deploy --config wrangler.maintenance.jsonc --env staging
npx wrangler deploy --config wrangler.cost-guard.jsonc --env staging
```

Migrations must run before the API Worker that calls them. Production should require a
manual approval and deploy in the order database, API Worker, maintenance Worker, then
frontend.

`npm run openapi:types` deterministically regenerates both `openapi.json` and
`frontend/src/api/generated.ts`; CI fails if either committed contract is stale.

## Security and operations

- JWT `issuer`, `audience`, expiry, signature, and `sub` are verified against Supabase JWKS.
- Authorization is repeated atomically inside each PostgreSQL RPC; client-supplied user IDs
  are never treated as the actor.
- JSON requests are capped at 2 MiB. File uploads go directly to R2 and are capped at
  25 MiB.
- Worker Rate Limiting bindings protect read, write, and progress bursts. Exact daily
  quotas and idempotency are PostgreSQL responsibilities.
- Logs contain request IDs, route, status, latency, and error code, but not bearer tokens,
  email addresses, answers, lesson payloads, or document content.
- The scheduled cleanup is idempotent. R2 deletion and Supabase Auth deletion both tolerate
  retries.

`/health/live` checks Worker execution. `/health/ready` opens a fresh Hyperdrive connection
and verifies the private database environment/project marker. The same assertion runs
inside every API and maintenance transaction before its business RPC, so a drifted
Hyperdrive origin fails closed. Monitor readiness at a modest frequency so health checks do
not consume connection capacity.

Credentialed staging smoke and the configurable 100-user/10-minute load gate are described
in [`../docs/runbooks/acceptance.md`](../docs/runbooks/acceptance.md). They require real
staging resources and dedicated test users, so they run through a manual protected workflow
instead of pull-request CI.

Sampled stats-row sizing, point-in-time lock/connection observations and the provider-side
70%/85% quota-alert checklist are documented in
[`../docs/runbooks/observability.md`](../docs/runbooks/observability.md).

The account-wide Workers/R2 safe envelope, exact custom-domain stop behavior, separate
80%/95% notifications, and protected below-5% resume procedure are documented in
[`../docs/runbooks/cost-guard.md`](../docs/runbooks/cost-guard.md).

# Meoing database

The SQL migrations in `migrations/` are the source of truth. The `app` and
`private` schemas are intentionally absent from the Supabase Data API schema
list in `config.toml`.

## Local verification

Supabase CLI requires a Docker-compatible runtime:

```powershell
npm --prefix backend run db:start
npm --prefix backend run db:reset
npm --prefix backend run db:test
```

`db:start` first creates an ignored local ES256 signing key at
`backend/supabase/signing_keys.json`. This keeps local Auth/JWKS behavior aligned with the
asymmetric keys required remotely.

## Runtime roles

Migrations create two `NOLOGIN`, `NOBYPASSRLS` capability roles:

- `meoing_runtime` can execute the public API RPC surface.
- `meoing_maintenance` can execute only the two maintenance cleanup/finalize RPCs.

Create separate login roles for each environment, grant only the relevant
capability role, and put those login connection strings in Hyperdrive. Do not
connect the API Worker as `postgres`.

```sql
create role meoing_api_login
  login
  noinherit
  nosuperuser
  nocreatedb
  nocreaterole
  noreplication
  nobypassrls
  connection limit 25
  password '<generated-secret>';
alter role meoing_api_login set search_path = pg_catalog;
alter role meoing_api_login set idle_in_transaction_session_timeout = '30s';
grant meoing_runtime to meoing_api_login
  with admin false, inherit false, set true;

create role meoing_maintenance_login
  login
  noinherit
  nosuperuser
  nocreatedb
  nocreaterole
  noreplication
  nobypassrls
  connection limit 8
  password '<generated-secret>';
alter role meoing_maintenance_login set search_path = pg_catalog;
alter role meoing_maintenance_login
  set idle_in_transaction_session_timeout = '30s';
grant meoing_maintenance to meoing_maintenance_login
  with admin false, inherit false, set true;
```

The API Hyperdrive origin connection limit is 20 and maintenance is 5. The
slightly larger PostgreSQL role limits allow connection churn without letting
either Worker consume the project's entire connection budget.

A fresh-project restore recreates only the capability roles. Reprovision both
login roles with new passwords, update the two Hyperdrive connection strings,
and restart their connection pools before routing traffic to the restored
project. Database migrations intentionally never store or recreate passwords.

## Database deployment identity

Every hosted database must have exactly one environment-owned marker before an
API Worker is routed to it. Migrations create the fail-closed table and
assertion function but deliberately do not guess an environment-specific
project ref. Deployment workflows run `npm run db:target:verify` before
`supabase link` and compare the target with an independently pinned expected
ref. Immediately after migrations they run `npm run db:identity:configure` and
refuse to deploy either Worker unless the linked database inserts or confirms
the exact marker, then verifies it in a second, post-commit statement. For
manual bootstrap or a restore drill, configure it through the Supabase SQL
editor:

```sql
insert into private.deployment_identity (
  singleton,
  environment,
  supabase_project_ref
)
values (
  true,
  '<staging-or-production>',
  '<20-character-project-ref>'
)
on conflict (singleton) do update
set environment = excluded.environment,
    supabase_project_ref = excluded.supabase_project_ref,
    configured_at = statement_timestamp();
```

The local seed writes `local` / `local`. API and maintenance transactions call
`private.assert_database_identity` before their business RPC in the same
round-trip, so a Worker whose Hyperdrive origin targets another environment
fails before reading, mutating or cleaning application data. `/health/ready`
returns the verified database marker.

The API Worker starts each transaction with `SET LOCAL ROLE meoing_runtime`
and sets `app.user_id` from the verified JWT subject. The maintenance Worker
uses `SET LOCAL ROLE meoing_maintenance`.

All application RPCs have one stable signature:

```sql
private.api_<operation>(p_input jsonb default '{}'::jsonb) returns jsonb
```

Before `api_username_availability` or `api_invite_accept`, the API Worker calls
`private.api_abuse_consume` in its own committed transaction. The Worker derives
`abuseKey` as a lowercase, 64-character HMAC-SHA256 hex digest using an
environment-specific secret; raw IP addresses and emails must never be sent to
or stored by PostgreSQL. Keeping the quota preflight in a separate transaction
ensures rejected lookup/invite attempts are still counted. Cloudflare Rate
Limiting remains the burst-control layer.

Maintenance is a two-phase protocol:

```sql
private.maintenance_cleanup(p_input jsonb default '{}'::jsonb) returns jsonb
private.maintenance_finalize(p_input jsonb default '{}'::jsonb) returns jsonb
```

`maintenance_cleanup` discovers due R2 keys, collection IDs, and Auth user IDs.
The Worker first removes the corresponding R2 objects and Auth users, treating an Auth 404
as success. Only candidates whose external deletion succeeded are passed to
`maintenance_finalize`; a transient external failure therefore remains retryable on the
next Cron run.

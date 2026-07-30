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
create role meoing_api_login login password '<generated-secret>';
grant meoing_runtime to meoing_api_login;

create role meoing_maintenance_login login password '<generated-secret>';
grant meoing_maintenance to meoing_maintenance_login;
```

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

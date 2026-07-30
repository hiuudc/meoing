# Staging acceptance and load gate

The repository includes two credentialed checks that run against real staging
resources. They are intentionally separate from pull-request CI: neither check
can be meaningful without Supabase Auth users, Hyperdrive, PostgreSQL and R2.

## Authenticated staging smoke

`npm run acceptance:staging` verifies:

- Worker liveness and PostgreSQL readiness through Hyperdrive;
- the exact staging CORS origin and rejection of an unrelated origin;
- OpenAPI publication and rejection of a forged JWT;
- a verified, username-onboarded Supabase account;
- denial of direct PostgREST access to the `app` schema;
- collection/unit create and update, including a stale revision conflict;
- with extended credentials, a custom summary-only role and single-use invite;
- a valid immutable lesson-v8 payload, progress start and exact batch retry;
- global/collection term stats, authorized member summaries, denial of raw
  answers without `view_member_answers`, then access after that permission is
  granted;
- private R2 initialize, signed PUT, finalize, signed GET and deletion.

The script uses disposable resources and soft-deletes the unit and collection in
a `finally` block. Run it with a dedicated verified staging account because
collection creation consumes its durable daily quota.

```powershell
$env:MEOING_ACCEPTANCE_API_URL = "https://api-staging.example.com"
$env:MEOING_ACCEPTANCE_SUPABASE_URL = "https://PROJECT.supabase.co"
$env:MEOING_ACCEPTANCE_SUPABASE_PUBLISHABLE_KEY = "..."
$env:MEOING_ACCEPTANCE_ALLOWED_ORIGIN = "https://staging.example.com"
$env:MEOING_ACCEPTANCE_EMAIL = "acceptance@example.com"
$env:MEOING_ACCEPTANCE_PASSWORD = "..."
$env:MEOING_ACCEPTANCE_EXTENDED = "true"
$env:MEOING_ACCEPTANCE_MEMBER_EMAIL = "acceptance-member@example.com"
$env:MEOING_ACCEPTANCE_MEMBER_PASSWORD = "..."
$env:MEOING_ACCEPTANCE_TURNSTILE_TOKEN = "..."
$env:MEOING_ACCEPTANCE_OUTPUT = ".acceptance-results/staging-smoke.json"
npm --prefix backend run acceptance:staging
```

`MEOING_ACCEPTANCE_ACCESS_TOKEN` may replace email/password for a one-off local
run. The Supabase URL and publishable key remain required for the Data API
denial check. No token, password, signed R2 URL or response content is written
to the console or result artifact.

The protected workflow sets `MEOING_ACCEPTANCE_EXTENDED=true`, so its smoke is
not considered complete without the second account and Turnstile token.
Configure staging invite protection with Cloudflare's documented Turnstile
test keys for automated acceptance; do not weaken production Turnstile.

## Full load gate

`npm run acceptance:load` defaults to 100 concurrent authenticated users for
600 seconds. Each virtual user is paced at 60 requests/minute and performs one
profile mutation per ten requests. It fails unless:

- authenticated read p95 is strictly below 400 ms;
- mutation p95 is strictly below 800 ms;
- the total error rate is strictly below 1%;
- every readiness sample succeeds throughout the run.

Use 100 distinct, verified and username-onboarded test users. Distinct users
are mandatory: reusing one identity would test the per-user burst limit and
profile revision conflicts rather than 100-user application load.

```powershell
$env:MEOING_LOAD_API_URL = "https://api-staging.example.com"
$env:MEOING_LOAD_SUPABASE_URL = "https://PROJECT.supabase.co"
$env:MEOING_LOAD_SUPABASE_PUBLISHABLE_KEY = "..."
$env:MEOING_LOAD_USERS_JSON = Get-Content -Raw ".private/staging-load-users.json"
$env:MEOING_LOAD_OUTPUT = ".acceptance-results/load-gate.json"
npm --prefix backend run acceptance:load
```

The users JSON has this shape and must never be committed:

```json
[
  { "email": "load-001@example.com", "password": "..." },
  { "email": "load-002@example.com", "password": "..." }
]
```

`MEOING_LOAD_ACCESS_TOKENS_JSON` is supported for short-lived manual runs.
`MEOING_LOAD_READ_ONLY=true` is diagnostic only; its result explicitly records
`fullGate: false` and does not validate mutation latency.

The load harness samples `/health/ready` while traffic is active. This detects
observable connection exhaustion, but it does not replace checking Hyperdrive
connection and PostgreSQL connection dashboards after the run.

## Database concurrency gate

CI runs `npm run db:concurrency` against the migrated local Supabase database
after pgTAP. The harness starts two independent `meoing_runtime` transactions
that redeem the same `maxUses=1` invite. It requires exactly one success, one
`INVITE_INVALID` result, one accepted member and `uses_count = 1`.

For a manual run, point `DATABASE_URL` at an isolated migrated database:

```powershell
$env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
npm --prefix backend run db:concurrency
```

The harness creates random users, a collection and an invite, then removes
them even when an assertion fails. Do not point it at production.

## Manual GitHub workflow

Run **Staging acceptance and load gate** from GitHub Actions after staging has
been deployed. Configure the protected `staging` environment with:

- variables `MEOI_API_URL`, `SUPABASE_URL`,
  `SUPABASE_PUBLISHABLE_KEY`, `MEOI_ACCEPTANCE_WEB_ORIGIN`;
- secrets `MEOI_ACCEPTANCE_EMAIL`, `MEOI_ACCEPTANCE_PASSWORD`;
- secrets `MEOI_ACCEPTANCE_MEMBER_EMAIL`,
  `MEOI_ACCEPTANCE_MEMBER_PASSWORD`, `MEOI_ACCEPTANCE_TURNSTILE_TOKEN`;
- secret `MEOI_LOAD_USERS_JSON` containing 100 load users.

The default workflow executes the exact 100-user/10-minute gate and retains
sanitized JSON summaries for 30 days. A smoke-only dispatch is useful for
diagnosis but does not satisfy the v1 load acceptance gate.

## Checks that remain manual

This harness does not pretend to automate browser- or lifecycle-dependent
acceptance. Before production, retain separate evidence for:

- Google OAuth callback/consent in a real browser;
- email verification and password reset through Brevo;
- Chrome extension interaction with ChatGPT and the rendered lesson UI;
- Turnstile with production keys;
- the 30-day account/collection purge and Auth-user deletion;
- the monthly encrypted backup restore drill;
- provider dashboard connection, quota and alert state.

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
$env:MEOING_ACCEPTANCE_EXPECTED_SUPABASE_PROJECT_REF = "abcdefghijklmnopqrst"
$env:MEOING_ACCEPTANCE_SUPABASE_PUBLISHABLE_KEY = "..."
$env:MEOING_ACCEPTANCE_ALLOWED_ORIGIN = "https://staging.example.com"
$env:MEOING_ACCEPTANCE_EMAIL = "acceptance@example.com"
$env:MEOING_ACCEPTANCE_PASSWORD = "..."
$env:MEOING_ACCEPTANCE_EXTENDED = "true"
$env:MEOING_ACCEPTANCE_MEMBER_EMAIL = "acceptance-member@example.com"
$env:MEOING_ACCEPTANCE_MEMBER_PASSWORD = "..."
$env:MEOING_ACCEPTANCE_TURNSTILE_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"
$env:MEOING_ACCEPTANCE_OUTPUT = ".acceptance-results/staging-smoke.json"
npm --prefix backend run acceptance:staging
```

`MEOING_ACCEPTANCE_ACCESS_TOKEN` may replace email/password for a one-off local
run. The Supabase URL and publishable key remain required for the Data API
denial check. No token, password, signed R2 URL or response content is written
to the console or result artifact.

Before acquiring either supplied or password-based tokens, the smoke requires
the Supabase URL to be canonical and `/health/live` to report `staging` with
the exact expected project ref. It then requires `/health/ready` to report the
same environment/project identity from PostgreSQL through Hyperdrive. This
fails before authentication or mutation if either a Worker variable or the
Hyperdrive origin drifts to production.

The protected workflow sets `MEOING_ACCEPTANCE_EXTENDED=true`, so its smoke is
not considered complete without the second account and Turnstile validation.
The staging website and API use Cloudflare's documented always-pass test
sitekey/secret pair, and the workflow submits `XXXX.DUMMY.TOKEN.XXXX`.
Production must use a real widget and secret; never deploy the test pair there.

## Provision acceptance accounts

Run `npm run acceptance:provision` before the authenticated smoke or load gate.
It idempotently creates or updates the two reserved smoke accounts and load
users 001-100, confirms their email addresses without sending mail, and
completes username onboarding through the staging API. This keeps
infrastructure acceptance independent of transactional-email delivery.

Create a new, temporary staging-only Supabase `sb_secret_*` key immediately
before provisioning. This provisioning key is a separate credential from the
`SUPABASE_SECRET_KEY` stored directly on the `meoing-maintenance-staging`
Worker. Never copy the maintenance Worker secret into GitHub, and never use a
production secret key for this operation. The command never prints credentials;
revoke the provisioning key as soon as provisioning succeeds.

```powershell
$env:MEOING_PROVISION_API_URL = "https://api-staging.example.com"
$env:MEOING_PROVISION_SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co"
$env:MEOING_PROVISION_EXPECTED_SUPABASE_PROJECT_REF = "abcdefghijklmnopqrst"
$env:MEOING_PROVISION_SUPABASE_SECRET_KEY = "sb_secret_..."
$env:MEOING_PROVISION_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_..."
$env:MEOING_PROVISION_OWNER_EMAIL = "acceptance-owner@auth.meoing.com"
$env:MEOING_PROVISION_OWNER_PASSWORD = "..."
$env:MEOING_PROVISION_MEMBER_EMAIL = "acceptance-member@auth.meoing.com"
$env:MEOING_PROVISION_MEMBER_PASSWORD = "..."
$env:MEOING_LOAD_EMAIL_TEMPLATE = "acceptance-load-{index}@auth.meoing.com"
$env:MEOING_LOAD_PASSWORD = "..."
npm --prefix backend run acceptance:provision
```

Before using Auth Admin, the command requires `/health/live` to report the
`staging` environment and requires the Supabase URL hostname to match
`MEOING_PROVISION_EXPECTED_SUPABASE_PROJECT_REF`. Use the 20-character project
ref shown in the staging Supabase dashboard. This value is an identifier, not a
secret. A mismatch fails before any user is created or updated.

The accepted identities are exact pairs:

- `acceptance-owner@auth.meoing.com` / `acceptance.owner`;
- `acceptance-member@auth.meoing.com` / `acceptance.member`;
- `acceptance-load-001@auth.meoing.com` through
  `acceptance-load-100@auth.meoing.com` / `load001` through `load100`.

The email template must contain exactly one `{index}` placeholder. Provisioning
expands it as `001` through `100`, and the load harness uses the same expansion.
All three passwords must contain at least 12 characters.

Every created Auth user receives an immutable ownership marker in
`app_metadata.meoing_acceptance` containing exactly the staging project ref and
expected username. Before making any Auth Admin mutation, a rerun pages through
the existing users and validates every matching email. It fails closed if an
existing identity has no marker, a different marker, or extra marker fields.
After authentication, it also requires the application profile username to
match the reserved pair before reporting success. Normal reruns rotate passwords
and confirm email without rewriting the ownership marker.

Provisioning and the load gate both pace Supabase password-token requests at
one request every 2.1 seconds. On HTTP 429 they honor `Retry-After` and use
bounded exponential backoff with jitter, up to eight attempts. The shared
defaults can be overridden with `MEOING_ACCEPTANCE_AUTH_INTERVAL_MS` and
`MEOING_ACCEPTANCE_AUTH_MAX_ATTEMPTS`; keep the defaults for hosted Supabase
unless the staging Auth rate limits have been deliberately changed.

## Cleanup acceptance accounts

Use `npm run acceptance:cleanup` only when specific reserved staging accounts
are no longer needed. Selection is an explicit JSON array of usernames; there
is no "all users" flag and an empty array fails. A repeated cleanup is safe:
selected users that are already absent are reported as absent without an Auth
mutation.

Before deleting anything, the cleanup command:

- requires the API URL to exactly equal the independently pinned
  `https://api-staging.meoing.com` HTTPS origin; a health response from an HTTP
  or foreign origin is never accepted as proof of identity;
- runs the same canonical Supabase URL, Worker staging identity and Hyperdrive
  database identity preflight as provisioning;
- derives the email from each exact reserved username instead of accepting an
  arbitrary email address;
- pages through Supabase Auth and requires
  `app_metadata.meoing_acceptance` to be an object containing exactly
  `{ "project_ref": "<expected staging ref>", "username": "<selected username>" }`;
- refuses missing markers, boolean markers (including `true`), wrong project or
  username values, extra marker fields, invalid Auth IDs and mismatched app
  profiles;
- authenticates each selected existing account and verifies its email-verified
  application profile and Auth user ID;
- globally revokes every selected account's Supabase refresh sessions before
  the first destructive R2 or database action;
- opens a direct TLS connection to the independently identified staging
  database, locks the collection/file mutation paths, revalidates the exact
  Auth marker and reserved profile pairs, and refuses an owned collection with
  an unmarked collaborator;
- deletes and HEAD-verifies every personal or selected-owner collection object
  in `meoing-files-staging`, purges the matching collections and app rows in one
  database transaction, anonymizes selected user references while retaining the
  audit tombstones, and leaves only a scrubbed, API-locked profile until Auth
  deletion makes a retry safe;
- hard-deletes each Auth user, verifies it is absent, then verifies there are no
  remaining app references, selected asset rows, collection rows or R2 objects.

Supabase access JWTs are stateless and may remain valid until their configured
expiry even after global sign-out. Session revocation still must precede Auth
deletion, and operators must allow one access-token lifetime before treating all
previously issued access JWTs as expired.

Create three temporary, staging-only credentials immediately before the run:

- an `sb_secret_*` Auth Admin key;
- a TLS `postgres` connection URL for this one operations run, with
  `sslmode=require` (never use a production URL);
- an R2 S3 token scoped only to Object Read & Write on
  `meoing-files-staging`.

Use the existing dedicated acceptance passwords. The cleanup never prints
passwords, access tokens, database URLs, account email addresses or R2 keys.
Revoke the Auth and R2 keys, delete their GitHub secrets, and rotate/remove the
temporary database credential as soon as the command finishes, whether it
succeeds or fails. The database connection is intentionally operations-only;
none of these credentials belongs in a Worker or frontend environment.

```powershell
$env:MEOING_CLEANUP_API_URL = "https://api-staging.meoing.com"
$env:MEOING_CLEANUP_EXPECTED_API_ORIGIN = "https://api-staging.meoing.com"
$env:MEOING_CLEANUP_SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co"
$env:MEOING_CLEANUP_EXPECTED_SUPABASE_PROJECT_REF = "abcdefghijklmnopqrst"
$env:MEOING_CLEANUP_SUPABASE_SECRET_KEY = "sb_secret_..."
$env:MEOING_CLEANUP_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_..."
$env:MEOING_CLEANUP_USERNAMES_JSON = '["acceptance.owner","load001"]'
$env:MEOING_CLEANUP_OWNER_PASSWORD = "..."
$env:MEOING_CLEANUP_MEMBER_PASSWORD = "..."
$env:MEOING_CLEANUP_LOAD_PASSWORD = "..."
$env:MEOING_CLEANUP_DATABASE_URL = "postgresql://postgres:...@.../postgres?sslmode=require"
$env:MEOING_CLEANUP_R2_ACCOUNT_ID = "..."
$env:MEOING_CLEANUP_R2_BUCKET_NAME = "meoing-files-staging"
$env:MEOING_CLEANUP_R2_ACCESS_KEY_ID = "..."
$env:MEOING_CLEANUP_R2_SECRET_ACCESS_KEY = "..."
npm --prefix backend run acceptance:cleanup
```

The protected **Cleanup staging acceptance users** GitHub workflow performs the
same operation and shares the `staging-acceptance` concurrency group so it
cannot race the smoke/load workflow. Its `usernames_json` input defaults to
`[]`, which intentionally fails until an operator supplies the exact reserved
usernames. The `staging` GitHub environment must restrict deployment branches
to `main`. The workflow also rejects a non-`main` ref before selecting the
environment, checks the ref again at runtime, and checks out the exact dispatch
SHA with persisted Git credentials disabled. It uses the protected staging
environment's existing acceptance passwords and publishable key plus newly
created temporary secrets:
`SUPABASE_PROVISIONING_SECRET_KEY`, `STAGING_CLEANUP_DATABASE_URL`,
`R2_STAGING_CLEANUP_ACCESS_KEY_ID` and
`R2_STAGING_CLEANUP_SECRET_ACCESS_KEY`. The R2 token must be restricted to the
staging files bucket. Secrets are exposed only to the destructive cleanup step,
not the checkout, dependency, or validation steps. Delete all four GitHub
secrets, revoke the two API keys, and rotate/remove the temporary database
credential immediately after the run.

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
$env:MEOING_LOAD_EXPECTED_SUPABASE_PROJECT_REF = "abcdefghijklmnopqrst"
$env:MEOING_LOAD_SUPABASE_PUBLISHABLE_KEY = "..."
$env:MEOING_LOAD_EMAIL_TEMPLATE = "load-{index}@example.com"
$env:MEOING_LOAD_PASSWORD = "..."
$env:MEOING_LOAD_OUTPUT = ".acceptance-results/load-gate.json"
npm --prefix backend run acceptance:load
```

The harness sets an HTTP/1.1 per-origin connection cap of at least one
connection per virtual user and
evenly spreads each user's request phase across the one-second request
interval. HTTP/2 is deliberately disabled in this single-process harness so
unrelated virtual users are not all multiplexed through one shared browser-like
session. This keeps the gate focused on Worker and database latency instead of
the load runner's local socket queue or an artificial once-per-second
thundering herd.
Set `MEOING_LOAD_CLIENT_CONNECTIONS` only when the runner has a known lower
connection limit; this is a lazy maximum rather than an observed socket count,
and the configured value is recorded in the JSON result. The gate also requires
at least 95% of the scheduled request volume so a stalled load generator cannot
pass on latency alone.

`MEOING_LOAD_ACCESS_TOKENS_JSON` is supported for short-lived manual runs.
`MEOING_LOAD_READ_ONLY=true` is diagnostic only; its result explicitly records
`fullGate: false` and does not validate mutation latency.

The same canonical-URL, Worker identity, Hyperdrive database identity and
readiness preflight runs before load-token resolution, including when access
tokens are provided directly.

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

- variables `MEOI_API_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
  `MEOI_ACCEPTANCE_WEB_ORIGIN`;
- secrets `MEOI_ACCEPTANCE_EMAIL`, `MEOI_ACCEPTANCE_PASSWORD`;
- secrets `MEOI_ACCEPTANCE_MEMBER_EMAIL`,
  `MEOI_ACCEPTANCE_MEMBER_PASSWORD`;
- secrets `MEOI_LOAD_EMAIL_TEMPLATE`, `MEOI_LOAD_PASSWORD`;
- secret `SUPABASE_PROVISIONING_SECRET_KEY`, containing a newly created,
  temporary staging `sb_secret_*` key. The workflow exposes it only to the
  provisioning step as `MEOING_PROVISION_SUPABASE_SECRET_KEY`.

The workflow reuses the dedicated identities by default and runs the exact
100-user/10-minute gate. Select `provision_accounts` only for initial setup or
credential rotation, after creating the temporary provisioning key. The
workflow pins the expected project ref to the committed staging identity and
requires `/health/live` to report the same project before provisioning, smoke
authentication or load authentication.
Revoke the temporary Supabase provisioning key and remove
`SUPABASE_PROVISIONING_SECRET_KEY` from the protected GitHub environment after
provisioning. The maintenance Worker's
`SUPABASE_SECRET_KEY` remains only in Cloudflare's Worker secret store and is
never required by this workflow. The workflow retains sanitized JSON summaries
for 30 days. A smoke-only dispatch is useful for diagnosis but does not satisfy
the v1 load acceptance gate.

The separate **Cleanup staging acceptance users** workflow requires the same
protected environment values plus an explicit `usernames_json` selection. Do
not dispatch acceptance/load work until cleanup completes, and do not leave the
temporary provisioning key in GitHub after either provisioning or cleanup.

The **Staging acceptance and load gate** workflow has the same trusted-code
boundary: the protected `staging` environment allows only `main`, the job and
runtime guard reject any other ref, and checkout uses the exact dispatch SHA
without persisted Git credentials. Each credential is scoped only to the
provisioning, smoke, or load step that consumes it.

## Manual cleanup for an unmarked SMTP canary

A one-off account created to prove verification or password-reset delivery may
predate the immutable acceptance marker. The automated cleanup must refuse that
account. Never add or alter `app_metadata.meoing_acceptance` merely to make the
cleanup command accept it.

Use this exact manual path for that one-off canary:

1. Keep the canary email and credentials in the private operations record only.
   Finish recording delivery, SPF, DKIM and DMARC evidence without copying the
   recipient address into Git, workflow output, issues or shared artifacts.
2. Open the staging website in a private browser window, sign in as the canary
   and verify the page is using staging. Use password recovery first if the
   dedicated password is unavailable but the test mailbox remains accessible.
3. Use Meoing's **Sign out** action. The frontend calls Supabase's default global
   sign-out, revoking refresh sessions for that user. Do not proceed to deletion
   if sign-out fails.
4. In the Supabase dashboard, open the staging project identified by this
   runbook, then **Authentication > Users**. Search the exact address from the
   private operations record, open only that user, re-check the project and
   address, and permanently delete the user (do not choose soft deletion if the
   dashboard offers it).
5. Confirm the user is absent from **Authentication > Users** and that a fresh
   sign-in fails. Allow one configured access-token lifetime before considering
   any JWT issued before sign-out expired.
6. From the original private test message, open the previously exposed invite
   link once in a new private browser session. Do not copy the URL into a shell,
   issue, workflow input, screenshot, console or committed file. Confirm that
   Supabase rejects the token (or redirects with an Auth error) and that the
   staging site has no authenticated session. Record only the pass/fail result
   and timestamp, never the URL or token.
7. Remove the canary credentials from the private operations store when the
   delivery evidence no longer requires them.

If neither the canary password nor its mailbox is available, stop and escalate
to a staging Supabase project owner. Do not use the automated cleanup, forge the
marker, or delete the user before a session-revocation path is established.

## Checks that remain manual

This harness does not pretend to automate browser- or lifecycle-dependent
acceptance. Before production, retain separate evidence for:

- Google OAuth callback/consent in a real browser;
- email verification and password reset through Cloudflare Email Sending SMTP,
  including delivery status and SPF/DKIM/DMARC results, followed by the manual
  unmarked-canary cleanup above;
- Chrome extension interaction with ChatGPT and the rendered lesson UI;
- Turnstile with production keys;
- the 30-day account/collection purge and Auth-user deletion;
- manual review of the automatic restore evidence for every successful weekly encrypted
  backup, including a weekly object and verification marker no more than eight days old;
- provider dashboard connection, quota and alert state.

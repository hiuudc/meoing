# Backend architecture

## Trust boundaries

1. Supabase Auth is the identity provider. Web clients may call Auth endpoints,
   but they cannot query application tables through PostgREST.
2. Every application request uses a Supabase access token in the
   `Authorization: Bearer` header.
3. The API Worker verifies the token against the project's JWKS and takes the
   actor ID only from the verified `sub` claim.
4. The Worker creates one short PostgreSQL transaction through Hyperdrive and
   sets the verified subject as transaction-local `app.user_id`.
5. PostgreSQL RLS and security-definer functions enforce collection membership,
   role hierarchy and ownership. Worker checks improve errors but never replace
   database authorization.
6. R2 objects are private. The API authorizes each upload/download before
   issuing a short-lived signed URL.

The public API Worker has no Supabase service-role or Auth Admin credential.
The maintenance Worker has no public route and owns only the credentials needed
for retention and account deletion.

## Data ownership

- `auth.users` owns login email and verification state.
- `app.profiles` owns public profile fields and onboarding/deletion state.
- Collections are the tenancy boundary; there is no workspace entity.
- Unit library content is embedded in four JSON arrays: words, phrases,
  sentences and documents. Ordering is presentation data stored in the scoped
  settings table.
- Lessons are immutable payloads. Publishing changes visibility, not content.
- Progress attempts stay in the progress row, while a small relational batch
  ledger provides idempotency.
- User and collection language statistics intentionally use JSON objects in v1.
  Their sampled row size, API database duration and point-in-time waiting-lock
  observations are operational scale signals. They are explicitly not
  continuous provider metrics.

## Runtime invariants

- Hyperdrive query caching remains disabled for actor-scoped data.
- Each request creates and closes its own `pg.Client`; Hyperdrive owns pooling.
- No request-scoped mutable module globals.
- Every asynchronous operation is awaited or attached to the Worker execution
  context.
- Logs contain request metadata and error codes only. Tokens, email addresses,
  answers, lessons and documents are redacted.
- API JSON bodies are capped at 2 MiB; a unit's embedded content is capped at
  1 MiB. Files up to 25 MiB bypass the Worker body through signed R2 uploads.

## Compatibility

The REST API is versioned under `/v1` and described by OpenAPI. Future native
mobile and other compatible clients should generate clients from that contract
instead of importing frontend types. Breaking contract changes require `/v2`;
database migrations should remain forward-compatible during staged deployment.

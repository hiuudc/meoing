# Meoing security policy

## Reporting

Do not include credentials, access tokens, invitation links, personal data, or
proof-of-concept user content in a public issue. Use GitHub private vulnerability
reporting when it is enabled; otherwise contact the repository owner through the
existing private project channel before disclosing details.

## Security boundaries

- Supabase Auth is the identity provider. Email verification is identity state,
  not application authorization.
- The public Cloudflare API Worker verifies JWT issuer, audience, expiry, and
  signature, then uses only the verified `sub` as the actor identifier.
- PostgreSQL RLS and functions in the unexposed `private` schema are the final
  authorization boundary. The runtime role must not own tables or bypass RLS.
- A collection is the tenant boundary. Cross-collection reads, role escalation,
  invite replay, and access to another owner's progress or R2 assets are security
  vulnerabilities.
- R2 buckets are private. Signed URLs are short-lived capabilities and must be
  issued only after database authorization.
- The maintenance and cost-guard Workers have no public routes. Their credentials
  are privileged operational secrets and must never enter the API Worker,
  frontend, extension, logs, or repository.
- The Chrome extension and all lesson/evaluation payloads are untrusted client
  input. Statistics are derived from the immutable server-side lesson tracking
  contract, not client-provided term lists.
- GitHub Actions, database migrations, backup/restore scripts, and deployment
  target guards are part of the production trust boundary.

## Required checks

- Run the repository CI, pgTAP/RLS tests, generated OpenAPI consistency checks,
  staging acceptance, and the load gate before production rollout.
- Run a Codex Security diff scan for every auth, RLS, storage, secret-handling,
  or deployment change. Run a full repository scan before the first production
  deployment, quarterly thereafter, and before introducing MCP, ChatGPT Apps, or
  mobile clients.
- Run dependency vulnerability and Git-history secret scans separately. Source
  review does not replace Supabase advisors or verification of deployed
  Cloudflare/Supabase configuration.
- Treat any shared invite or reset URL as compromised. Invalidate it by removing
  the exact test user and revoking its sessions; never reuse it for a real user.

## Secrets and test data

- Store runtime secrets in Cloudflare Worker secrets and deployment secrets in
  protected GitHub environments. Frontend variables must be publishable values.
- Acceptance users must carry a structured
  `app_metadata.meoing_acceptance` marker containing the exact staging project
  reference and reserved username. Cleanup automation must fail closed for all
  other users.
- Never log Authorization headers, SMTP credentials, email addresses, raw
  answers, document content, lesson content, or backup encryption material.

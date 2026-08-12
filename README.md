# Meoing

Meoing is an open-source language learning workspace for organizing study material, generating structured lessons, and tracking practice progress. It is an early-stage project maintained by [hiuudc](https://github.com/hiuudc).

## Architecture

```text
React website -> Cloudflare Worker -> PostgreSQL / private R2
                              -> OpenAI Responses API
```

The browser authenticates with Supabase, then uses the Worker as the only application-data entry point. The Worker rehydrates authorized unit and lesson context from PostgreSQL, reserves quota before an AI request, calls the official OpenAI Responses API with `store: false`, validates the result, and settles usage without logging learning content.

## Privacy and AI consent

The API provider is opt-in. Before an AI operation, Meoing shows a consent dialog explaining that the selected unit material and the answer necessary for the operation are sent to OpenAI. Audio recordings and sign-in tokens are not sent. Consent is versioned, user-scoped, and can be withdrawn immediately.

The default limits are five lesson generations and 100 evaluations or coaching requests per user per UTC day. The Worker also applies a configured global daily budget and fails closed if it is missing in production.

## Repository layout

```text
frontend/   React website
backend/    Cloudflare Workers, SQL migrations, database tests
packages/   Versioned contracts shared by app and provider clients
docs/       Architecture, security, operations, and OSS application material
```

## Local setup

Requirements: Node.js 22+, Docker-compatible runtime, Supabase, and Cloudflare Wrangler access for local Worker development.

```powershell
npm --prefix frontend install
npm --prefix backend install
Copy-Item backend/.dev.vars.example backend/.dev.vars
npm run dev:local
```

Set `OPENAI_API_KEY` and the budget variables in `backend/.dev.vars` only when testing live AI operations. Never commit that file. You can develop and test library, auth, and local lesson UI without an OpenAI key.

Run verification:

```powershell
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix backend run check
```

## Security model

- The Worker verifies Supabase JWTs; PostgreSQL RLS and private RPCs authorize every collection-scoped operation.
- OpenAI credentials live only in Cloudflare Worker secrets.
- AI requests are idempotent and ledgered; prompts, answers, and generated content are not emitted to Worker logs.
- Private R2 files use short-lived, authorized URLs.

See [SECURITY.md](SECURITY.md), [backend/README.md](backend/README.md), and [docs/codex-oss-application.md](docs/codex-oss-application.md) for operational details.

## License

Meoing source code is licensed under [Apache-2.0](LICENSE). Third-party dependencies and character data retain their original licenses; see [NOTICE](NOTICE).

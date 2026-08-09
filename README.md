# Meoing

Meoing is a monorepo containing the React website, the Meoi Bridge Chrome
extension, and a Cloudflare Workers API backed by Supabase PostgreSQL and
Cloudflare R2.

## Repository layout

```text
meoing/
  frontend/   React website and Meoi Bridge Chrome extension
  backend/    Workers API, maintenance Worker, SQL migrations and DB tests
```

## Requirements

- Node.js 22 LTS.
- A Docker-compatible runtime for the local Supabase stack.
- A Supabase project and Cloudflare account for remote staging/production.

## Commands

Run commands from the monorepo root:

```powershell
npm --prefix frontend install
npm --prefix backend install

# One terminal for local Supabase, the API Worker, and the website.
# This preserves the existing local database.
npm run dev:local

npm --prefix frontend run dev
npm --prefix frontend run test
npm --prefix frontend run build

npm --prefix backend run db:start
npm --prefix backend run db:reset
npm --prefix backend run dev
npm --prefix backend run check
```

Before the first `npm run dev:local`, create `backend/.dev.vars` from
`backend/.dev.vars.example` and configure the local-only secrets required by
the API Worker. Keep one variable per real line; the launcher rejects escaped
`\\n` text, missing local Auth values, and placeholder Supabase URLs. It also
verifies `frontend/.env.local`,
starts local Supabase, then starts the API Worker and Vite in the same
terminal. Open `http://127.0.0.1:5173` once both services are ready.
The launcher also creates or repairs the restricted `meoing_api_login` role
used by the local Worker; it never connects the API as the `postgres` role.
On Windows, it automatically stops only an existing Meoing local frontend or
API Worker detected on ports `5173` and `8787`; a different process on either
port remains protected and produces an explicit error.

`npm run dev:local` never resets local data. Apply new migrations explicitly
when needed with `npm --prefix backend run db:reset`.

Local Auth emails are captured instead of delivered. After signup or password
recovery, open `http://127.0.0.1:54324` and follow the email link. A database
reset removes local accounts, so sign out any stale browser session and create
a new local account afterward.

The website authenticates directly with Supabase Auth, then sends the access
token to the Worker API. Application tables are not exposed through the
Supabase Data API. Large files are uploaded directly to private R2 objects using
short-lived signed URLs.

See [`frontend/README.md`](frontend/README.md) for the website/extension
workflow and [`backend/README.md`](backend/README.md) for local infrastructure,
secrets, migrations and deployment.

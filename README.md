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
the API Worker. The launcher verifies that file and `frontend/.env.local`,
starts local Supabase, then starts the API Worker and Vite in the same
terminal. Open `http://127.0.0.1:5173` once both services are ready.

`npm run dev:local` never resets local data. Apply new migrations explicitly
when needed with `npm --prefix backend run db:reset`.

The website authenticates directly with Supabase Auth, then sends the access
token to the Worker API. Application tables are not exposed through the
Supabase Data API. Large files are uploaded directly to private R2 objects using
short-lived signed URLs.

See [`frontend/README.md`](frontend/README.md) for the website/extension
workflow and [`backend/README.md`](backend/README.md) for local infrastructure,
secrets, migrations and deployment.

# Meoing

Meoing is organized as a monorepo. The current repository contains the Meoi browser-local language workspace and its Chrome extension; a backend package can be added later without changing the frontend package boundary.

## Repository layout

```text
meoing/
  frontend/   React website and Meoi Bridge Chrome extension
```

No backend package is present yet.

## Requirements

- Node.js 22 LTS or newer.
- The portable Node.js runtime in `.tools/` can be used for local development.

## Commands

Run commands from the monorepo root:

```powershell
$env:PATH = "$(Resolve-Path '.\.tools\node-v22.23.1-win-x64');$env:PATH"
npm --prefix frontend run dev
npm --prefix frontend run test
npm --prefix frontend run build
```

See [`frontend/README.md`](frontend/README.md) for the website and extension workflow.

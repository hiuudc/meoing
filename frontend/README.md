# Meoing website

The website is a React 18 and Vite application. It uses Supabase Auth and the Cloudflare Worker in `../backend` for all canonical workspace data and AI operations.

## Commands

```powershell
npm install
npm run dev
npm run test
npm run build
```

Copy `.env.example` to `.env.local` and configure only public Supabase and API values. API credentials never belong in this package.

## AI provider

The default provider is the official OpenAI API through the Worker. User consent is required before a unit's learning material or answer is sent for a lesson generation, evaluation, or coaching operation. The Worker reserves quota atomically, uses `store: false`, validates structured output, and does not log prompt or answer content.

The UI retains a provider setting for compatible external connectors, but this public repository contains no connector source, browser automation, provider-specific web integration, or installation instructions.

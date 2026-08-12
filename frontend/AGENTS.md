# AGENTS.md

These instructions apply to the `frontend/` package. The monorepo-level rules are in the parent `AGENTS.md`.

## Project Overview

Meoi is an authenticated language workspace with a Discord-style layout. This package contains the React website. It uses Supabase Auth and the Cloudflare Worker API in `../backend/`; PostgreSQL-backed API data is authoritative for accounts, collections, units, documents, learning content, progress, permissions, settings, AI consent, and lifecycle operations. Browser storage remains important for narrowly scoped resilience and legacy cleanup, but it is not the canonical application database.

### Current Stack

- React `18.3.1` with functional components and `react-dom/client`.
- TypeScript with strict checking enabled.
- Vite `6` for development and production web builds.
- Vitest `4` for web unit tests.
- Playwright `1.60.0` is installed for browser verification, but there is no committed end-to-end test script.
- `@supabase/supabase-js` for PKCE authentication and persisted, auto-refreshed sessions.
- `lucide-react` for icons.
- One website-global CSS file with responsive media queries and CSS custom properties.
- React `useReducer` for the normalized in-memory workspace view, hydrated from and mutated through the API.
- IndexedDB for the user-scoped, retryable progress outbox.

Use Node.js `>=22`, matching this package's `engines` declaration and the monorepo `.nvmrc`.

### Important Files

- `src/main.tsx`: React entrypoint and global CSS import.
- `src/App.tsx`: authenticated application composition, cloud-workspace hydration, API mutation orchestration, reducer wiring, modal/drawer lifecycle, and draft theme preview priority.
- `src/auth/AuthProvider.tsx`: Supabase client/session lifecycle, authenticated `ApiClient`, profile loading, sign-in/out, recovery, OAuth, and post-auth outbox flushing.
- `src/api/client.ts`: authenticated API envelope/error handling and idempotency-key support.
- `src/api/generated.ts`: generated OpenAPI types; regenerate from the backend rather than hand-editing it.
- `src/api/workspace.ts`: API-to-workspace normalization and paginated cloud hydration.
- `src/api/progressOutbox.ts`: user-scoped IndexedDB queue, retry, quarantine, and idempotent progress delivery.
- `src/components/`: named React UI components.
- `src/store.ts`: normalized client reducer, seed/empty state helpers, and retained legacy localStorage normalization utilities.
- `src/integration/`: browser resilience, local recovery, and legacy browser-data cleanup.
- `src/learning/`: lesson generation, session, evaluation, rendering, and local recovery helpers.
- `src/ai/`: provider-neutral client helpers and API consent UI when present.
- `src/theme.ts`: pure theme utilities, palette presets, color conversion helpers, and CSS variable generation.
- `src/types.ts`: shared domain, state, and action types.
- `src/styles.css`: global styles, theme-variable usage, and responsive breakpoints.

## Required Skills

- For all UI work, load and follow `vercel:react-best-practices` before editing or reviewing code.
- UI work includes React and TSX changes, CSS, layouts, responsive behavior, accessibility, theme helpers, rendering-related UI state flows, UI reviews, refactors, and performance work.
- Apply the skill together with this repository's local rules. The local rules document Meoi-specific architecture, behavior, and verification requirements.
- Do not copy the full skill into this file. Load the maintained installed skill when the task begins.
- If `vercel:react-best-practices` is unavailable, use an equivalent installed React best-practices skill, state the fallback clearly, and continue following this file.
- For rendered UI changes, preserve the Playwright verification workflow described in `Testing and Quality`.

## Setup and Commands

Run commands from the `frontend/` directory, or use `npm --prefix frontend` from the monorepo root.

```bash
npm install
npm run dev
npm run build
npm run test
npm run test:watch
npm run preview
```

- `npm run dev`: starts the Vite development server.
- `npm run build`: cleans generated output, type-checks, and builds the Vite website.
- `npm run test`: runs the web Vitest suite once.
- `npm run test:watch`: runs Vitest in watch mode.
- `npm run preview`: serves the production bundle locally.
- Lint command: not available.
- Format command: not available.
- Committed Playwright or end-to-end command: not available.

Do not invent lint, format, or end-to-end scripts in reports. Adding those tools is an optional recommendation and must be an explicit task.

## Architecture and State

- Keep Supabase Auth/session concerns in `src/auth/`. The authenticated `ApiClient` created by `AuthProvider` is the normal path to application data.
- Treat the backend API and database as canonical. Hydrate the normalized reducer through `loadCloudWorkspace`; successful remote mutations may update local reducer state or trigger a refresh, but local state alone is not durable.
- Keep workspace domain state in the existing normalized reducer structure in `src/store.ts`.
- Use reducer actions for collection, unit, document, and study-item changes. Do not mutate reducer inputs.
- Keep transient UI state local to the owning component or in `App.tsx` when multiple surfaces coordinate it.
- Do not duplicate derived lists in state. Derive active collections, units, documents, and study items from normalized records and order arrays.
- Do not add new canonical workspace persistence to `localStorage`. `loadWorkspace`/`saveWorkspace` and `STORAGE_VERSION` remain for tested legacy compatibility; preserve their normalization unless an intentional migration/removal is part of the task.
- Keep retryable lesson-progress batches in the existing user-scoped IndexedDB outbox. Preserve stable batch/event IDs across retries, acknowledge only successful API writes, and quarantine terminal rejections instead of silently dropping them.
- Keep AI operations behind the versioned contract and authenticated API client. Do not add provider secrets, prompts, answers, or browser automation APIs to React components.

### Theme Invariants

- `ThemeConfig.selection` is exclusive: exactly one of Base, Color palette, or Custom is selected.
- Use `selectBaseTheme`, `selectColorTheme`, `markThemeCustom`, and `reconcileThemeSelection` from `src/theme.ts`. Do not manually recreate their behavior in components.
- Base themes render neutral surfaces. Color presets use canonical dusk surfaces. Drawer edits mark the draft as Custom.
- Preserve the draft lifecycle: Appearance and drawer changes preview live, Apply persists, close and Escape discard, and drawer Back returns to Appearance with the draft.
- Keep legacy theme normalization compatible with existing `meoi.workspace.v1` localStorage data.

## React Rules

- Use functional components and named exports. Existing component files and component names use PascalCase.
- Keep components focused. Extract repeated UI into reusable components instead of copying markup.
- Keep rendering pure. Do not mutate props, state, arrays, or objects passed into JSX.
- Run side effects only in event handlers or effects, never during render.
- Prefer composition and small helpers over deeply nested conditional rendering.
- Use `useMemo` only for meaningful derived work. Do not memoize everything by default.
- Avoid unnecessary re-renders, but do not add `React.memo`, `useMemo`, or `useCallback` without a concrete reason.
- Add lazy loading or code splitting only when a measured need exists.

## Hooks Rules

- Call Hooks only at the top level of React components or custom Hooks.
- Never call Hooks inside loops, conditions, nested functions, event handlers, async functions, or after an early return.
- Name custom Hooks with a `use` prefix.
- Keep effect dependency arrays correct.
- Avoid unnecessary effects. Derive values during render when possible.
- Clean up global listeners and other external subscriptions from effects.

## TypeScript Rules

- Keep strict TypeScript passing. Do not silence errors without an explanation.
- Use `interface` for shared object shapes and `type` for unions, matching `src/types.ts`.
- Type component props clearly with local prop interfaces unless they are shared domain types.
- Avoid `any`. Use narrow unions, generics, or `unknown` with validation when data is untrusted.
- Keep shared domain, state, action, and theme-selection types in `src/types.ts`.
- Preserve immutable updates for reducer state and theme arrays.

## File and Folder Rules

Follow the current package organization.

```text
src/
  App.tsx
  main.tsx
  styles.css
  store.ts
  theme.ts
  types.ts
  api/
  auth/
  components/
  integration/
  learning/
```

- Put reusable UI sections, modals, drawers, and workspace panels in `src/components/`.
- Keep top-level app orchestration in `src/App.tsx`.
- Keep reducer actions, seed/empty state helpers, and legacy storage compatibility in `src/store.ts`.
- Keep remote contracts and calls in `src/api/`, authentication in `src/auth/`, browser-local persistence in `src/integration/`, and learning behavior in `src/learning/`.
- Keep pure theme and color utilities in `src/theme.ts`.
- Keep shared types in `src/types.ts`.
- Keep global CSS in `src/styles.css`.
- Do not move files unless the task requires it.

The project does not currently use pages, layouts, services, or assets folders as primary conventions. Add new top-level folders only when a feature genuinely needs them; prefer the established `api`, `auth`, `components`, `integration`, and `learning` boundaries.

## Styling and UI Rules

- Use the existing global CSS approach. Do not introduce Tailwind, CSS Modules, CSS-in-JS, or another styling library without an explicit task.
- Use the CSS variables produced by `themeStyle()` for repeated surfaces, text colors, borders, accents, and gradients.
- Keep responsive behavior working at the existing `1180px`, `820px`, and `560px` breakpoints.
- Preserve the desktop four-column workspace, tablet reductions, mobile navigation drawer, Appearance modal, and mobile full-screen theme drawer.
- Reuse existing spacing, typography, border radius, and token patterns before adding new values.
- Keep focus-visible styles and reduced-motion support.

## Accessibility Rules

- Use semantic elements such as buttons, inputs, labels, headings, tables, dialogs, and asides appropriately.
- Add accessible labels to icon-only buttons and form fields.
- Use `aria-pressed` for selectable theme tiles and keep visual selected state aligned with accessible state.
- Preserve keyboard support for the custom color picker and Escape-based dismissal.
- Use alt text for meaningful images if images are introduced.
- Do not remove focus indicators unless an accessible replacement is added.

## Animation Rules

- Keep animations subtle, fast, and useful.
- Do not animate everything.
- Use existing animation libraries or CSS approach already used by the project.
- For modals, dropdowns, sidebars, and mobile menus, support both enter and exit animations.
- Respect accessibility and `prefers-reduced-motion`.
- Do not add animation dependencies without a clear reason.

## API and Data Rules

- Use `src/api/client.ts` for authenticated Worker API requests and keep endpoint-specific mapping helpers in `src/api/`. Keep network calls out of deeply nested presentation components and preserve explicit loading, empty, success, conflict, and error states.
- The backend OpenAPI contract is authoritative. Regenerate `src/api/generated.ts` with the backend `openapi:types` script when the contract changes; do not manually patch generated types.
- Use Supabase directly only for Auth flows. Application tables, R2 authorization, permissions, rate limits, lifecycle operations, and business rules go through the Worker API; never call PostgREST application tables from the browser.
- Treat client-side permission checks as presentation hints. The backend must remain the authorization authority for every protected operation.
- Preserve API idempotency keys for retryable mutations and progress-outbox batches. Do not generate new batch/event IDs merely because a request is retried.
- Public frontend configuration is read through `src/api/config.ts` from `VITE_MEOI_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and optional `VITE_TURNSTILE_SITE_KEY`. These values may be public, but service-role/secret keys, passwords and access tokens must never enter frontend source, build variables, logs, URLs, or committed files.

## Testing and Quality

- Add or update Vitest coverage when changing reducer behavior, API mapping/client behavior, Auth helpers, outbox semantics, AI provider selection, persistence compatibility, theme helpers, or selection fallbacks.
- Run `npm run test` and `npm run build` before finishing code changes.
- For rendered UI changes, use Playwright with the installed dependency to verify desktop and mobile behavior, interactions, console health, and layout overflow.
- Temporary Playwright scripts and screenshots must not be committed. Remove temporary `.qa` files after verification.
- Do not leave unused imports, dead code, debug logs, or commented-out code.
- Since lint and format scripts do not exist, rely on TypeScript build checks and the existing code style.

## Security Rules

- Never commit secrets, API keys, tokens, credentials, or private URLs.
- Let the Supabase client manage access/refresh tokens; do not copy tokens into app state, localStorage keys, logs, error reports, or AI operation payloads.
- Validate and normalize browser-stored legacy/recovery data before relying on it, and scope IndexedDB records to the authenticated user.
- Validate user input where relevant and keep destructive actions behind confirmation.
- Do not add `dangerouslySetInnerHTML` or equivalent unsafe HTML rendering without a documented, reviewed sanitization strategy.
- Explain the need and risk before adding dependencies with security implications.

## Git and Change Rules

- Make minimal, focused changes.
- Preserve existing behavior unless the task explicitly requests a behavior change.
- Do not rewrite large areas of the app for a narrow request.
- Do not revert unrelated user changes in a dirty worktree.
- Report the commands run and any commands that could not be run.
- Keep generated output such as `dist/`, `node_modules/`, and `*.tsbuildinfo` out of commits.

## AI Agent Workflow

- Inspect relevant files before editing.
- Follow repository patterns over generic preferences.
- Ask for clarification only when the answer cannot be discovered and a reasonable assumption would be risky.
- Prefer small, verifiable changes.
- Do not create fake files, APIs, tests, or documentation claims.
- State uncertainty directly when repository evidence is incomplete.
- For UI work, carry the task through implementation, `npm run test`, `npm run build`, and rendered browser verification when feasible.

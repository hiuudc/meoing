# AGENTS.md

## Project Overview

Meoing is an Apache-2.0 language-learning workspace. `frontend/` contains the React website, `backend/` contains Cloudflare Workers and PostgreSQL migrations, and `packages/` contains versioned shared contracts. The public application uses the official OpenAI API through the Worker; no browser automation integration is part of this repository.

## Repository Rules

- Keep shared tooling, documentation, and Git metadata at the monorepo root.
- Keep website code in `frontend/`, Workers and database code in `backend/`, and reusable contracts in `packages/`.
- Follow `frontend/AGENTS.md` for all UI changes; its React best-practices skill remains mandatory.
- Keep provider credentials in Worker secrets. Do not add browser API keys, provider URLs, prompts, answers, or generated lesson data to logs.
- Do not commit `.qa`, `.tools`, dependencies, build output, caches, TypeScript build metadata, or local environment files.
- Preserve Git history and keep changes focused on the relevant package.

## Git Workflow

- Work on the current branch by default. Do not create a new branch merely to make a focused commit or pull request.
- Create a branch only when the user requests one, concurrent work needs isolation, or repository protection requires a pull request from a non-default branch.
- When a task is complete and no other active task modifies the same files, create a focused local commit before reporting completion.
- Stage only task files and use a concise, accurate commit message.
- If another active task overlaps a file, wait until that overlap is resolved before committing.
- Do not push or change repository visibility unless the user explicitly asks.

## Animation Rules
- Keep animations subtle, fast, and useful.
- Do not animate everything.
- Use existing animation libraries or CSS approach already used by the project.
- For modals, dropdowns, sidebars, and mobile menus, support both enter and exit animations.
- Respect accessibility and `prefers-reduced-motion`.
- Do not add animation dependencies without a clear reason.

## Verification

For frontend changes, run:

```powershell
npm --prefix frontend run test
npm --prefix frontend run build
```

For Worker or database changes, additionally run:

```powershell
npm --prefix backend run check
```

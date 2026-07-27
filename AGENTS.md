# AGENTS.md

## Project Overview

Meoing is a monorepo. The current implementation lives in `frontend/`, which contains the React website and the Meoi Bridge Chrome extension. No backend package exists yet.

## Repository Rules

- Keep `.git`, `.gitignore`, `.nvmrc`, root documentation, and shared local tooling at the monorepo root.
- Put frontend application code, extension code, package metadata, and build configuration in `frontend/`.
- Put a future backend in `backend/`; do not mix backend source into `frontend/`.
- Follow `frontend/AGENTS.md` for all frontend work. Its React best-practices skill requirement remains mandatory for UI work.
- Run frontend commands from `frontend/` or with `npm --prefix frontend` from the monorepo root.
- Do not commit `.qa`, `.tools`, dependencies, build output, caches, or TypeScript build metadata.
- Preserve existing Git history and keep changes focused on the relevant package.

## Git Workflow

- When a task is complete and no other active task is modifying any of the same files, create a focused local commit before reporting completion.
- Stage only files that belong to the completed task, and use a concise commit message that accurately describes what was implemented.
- If another active task overlaps any file, wait until the overlap is resolved before committing so unrelated or partial work is not mixed.
- Do not push unless the user explicitly asks. A local commit does not imply permission to push.

## Verification

For frontend changes, run:

```powershell
npm --prefix frontend run test
npm --prefix frontend run build
```

Use the retained Playwright dependency for rendered UI verification without installing or uninstalling it for each test run.

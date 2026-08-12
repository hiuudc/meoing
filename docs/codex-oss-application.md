# Codex for Open Source application notes

## Project

Meoing is an Apache-2.0 language-learning workspace. It helps learners organize material into collections and units, generate structured practice, and retain progress under collection-scoped permissions.

## Maintainer and maturity

The project is maintained by `hiuudc` and is in an early public stage. This application does not claim unverified user, contributor, download, or adoption metrics. The public repository has documented contribution, release, support, and security practices, along with automated frontend, Worker, and database checks.

## Technical practice

The React website uses a Cloudflare Worker as its canonical API. The Worker validates identity, permission, consent, structured AI output, idempotency, and quota before writing application data. It uses the official OpenAI Responses API with `store: false`; API credentials remain server-side.

## Use of Codex credits

Credits would support maintainer automation such as test repair, dependency updates, accessibility improvements, documentation maintenance, database/RLS review, and safe migration work. They are separate from user-facing OpenAI provider calls, which are governed by Meoing's server-side quota and budget controls.

## Pre-submission checklist

- Confirm the GitHub profile and repository are public.
- Confirm the maintainer is actively reviewing issues and pull requests.
- Verify CI, release notes, security reporting, dependency review, and secret scans from a clean clone.
- Do not claim adoption or compliance beyond evidence available at submission time.

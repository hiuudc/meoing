# Release policy

Maintainers release changes from reviewed commits on `main` after CI passes. Security fixes may be released out of the normal cadence. Release notes must describe user-visible behavior, migration requirements, and any operational configuration changes.

The public repository must not contain production credentials, private infrastructure identifiers, user content, or generated deployment artifacts. Tracked Wrangler files deliberately contain non-deployable placeholders; maintainers use untracked `backend/wrangler.*.private.jsonc` overlays and CI secrets for real deployments. Before a release, run dependency and secret scans, verify a clean-clone build, and review license notices for newly added dependencies or data.

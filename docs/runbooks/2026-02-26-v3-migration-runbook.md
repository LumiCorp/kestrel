---
id: runbook-v3-migration-2026-02-26
domain: ops
status: historical
owner: kestrel-ops
last_verified_at: 2026-03-24
depends_on: [../index.md, ../../ARCHITECTURE.md]
---

# Kestrel v3 Migration Runbook (2026-02-26)

## Goal

Complete v2 -> v3 carry-forward with:
1. active/resumable sessions migrated for continued execution.
2. non-migrated sessions archived and marked `legacy_readonly`.

## Prerequisites

1. Postgres is running.
2. Latest schema migrations are applied:
`pnpm run db:migrate`
3. Runtime deploy is paused or in maintenance mode.

## Dry-Run Checklist

1. Run:
`pnpm run db:migrate:v3 -- --dry-run --scope active-resumable`
2. Verify output lists:
   - `migratable_ids`
   - `archive_only_ids`
   - `blocked`
3. Confirm blocked IDs are expected (typically missing IDs when using `--scope ids`).
4. Save dry-run output in release notes.

## Apply Checklist

1. Execute:
`pnpm run db:migrate:v3 -- --apply --scope active-resumable`
2. Validate:
   - migrated sessions now have `schema_version = 3` and `legacy_readonly = false`
   - archived sessions have rows in `legacy_session_archives`
   - archived sessions have `legacy_readonly = true`
3. Spot-check run events:
   - `migration.session_migrated`
   - `migration.session_archived`
4. Run verification suite:
`pnpm run typecheck && pnpm run test && pnpm run build`

## Rollback Guidance

1. No in-place downgrade is provided for v3 schema fields.
2. Recover skipped/archived legacy sessions from `legacy_session_archives.snapshot_json`.
3. If a migrated session is invalid:
   - set `legacy_readonly = true`
   - restore state from archive snapshot into a new session ID
   - resume from the new ID to avoid mutating historical rows.

## Historical Note

This runbook documents the point-in-time v2 to v3 migration and is not the current general storage operations guide.

- [Architecture](ARCHITECTURE.md)
- [Migration operations page](apps/docs/content/operations/migration.mdx)
- [Mountain Top Runbook](docs/runbooks/2026-03-23-mountaintop-runbook.md)

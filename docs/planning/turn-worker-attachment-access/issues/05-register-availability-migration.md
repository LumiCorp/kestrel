# Register the blob availability migration with the deployed runner

## Failed behavior

The availability migration file exists, but the migration ledger does not register it. Deployed databases therefore remain without `availability_status` and `availability_checked_at` while updated application code queries and writes those columns.

## Affected work

This blocks [Make blob availability durable across every byte consumer](01-enforce-durable-blob-availability.md), introduced in local commit `74135b144`. The owning path is `apps/web/lib/db/migrations/0080_file_blob_availability.sql` and its `lib/db/migrations/meta` registration, consumed by `apps/web/lib/db/migrate.ts`.

## Repair requirements

Register migration 0080 in the repository's migration journal and history lock with the correct ordering, timestamp, tag, and content hash. Preserve the additive migration semantics: historical blobs become `unknown`, existing file and relationship rows remain intact, and the migration is safe for the current deployment sequence.

## Done when

- The migration runner discovers and applies 0080 in a clean and already-migrated database.
- The journal and history-lock entries agree with the file's tag, timestamp, and hash.
- A focused migration regression test proves registration and the new columns/check constraint after application.
- Issue 01's code can query the availability columns in a deployed database without schema errors.

## Depends on

None.

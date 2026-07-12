# Threads and Projects migration runbook

Migration `0013_threads_projects` is a hard product cutover. It renames the physical `chats` and `messages` tables to `threads` and `thread_messages`, renames every supported `chat_id` foreign key, and adds the hosted Project, membership, immutable context-revision, and audit tables. It intentionally does not create compatibility views or legacy routes.

## Preflight

1. Stop Kestrel One application and worker writes.
2. Take a database snapshot and confirm it can be restored into a separate database.
3. Record row counts for `chats`, `messages`, `artifact_documents`, and `media_generation_jobs`.
4. Record IDs and object-storage keys for a representative sample, including public shares and artifacts.
5. Confirm Redis and object storage are healthy; the migration changes database references but does not move object bytes.

Apply the migration with `pnpm --filter @kestrel/kestrel-one db:migrate`.

## Verification

After migration, verify all of the following before resuming traffic:

- `threads` has the former `chats` row count and `thread_messages` has the former `messages` row count.
- Sample Thread IDs, share tokens, transcripts, artifact references, media references, and storage keys are unchanged.
- Every migrated user message has its legacy Thread creator in `author_user_id`.
- `chats`, `messages`, and all supported `chat_id` columns no longer exist.
- All foreign-key constraints are validated.
- Deferred database constraints reject both ownerless Project creation and removal of a Project's last owner, while allowing an owner transfer in one transaction.
- `drizzle.__drizzle_migrations` contains `0013_threads_projects` exactly once.
- A migrated Thread resumes the runner session under the same Thread ID.

The production-like migration check for this change cloned the pre-migration local Postgres database, inserted a representative shared Thread with a transcript, artifact, and media job, applied the migration, and confirmed equal row counts, unchanged IDs/share token/references, populated authorship/search text, no legacy tables or columns, and no unvalidated foreign keys. A second fresh clone proved that a valid Project-and-owner transaction commits, ownerless creation and last-owner removal fail at commit, and Project deletion still cascades cleanly.

## Rollback

This is a rename migration, so rollback is snapshot restoration rather than a reverse migration. If any verification fails, keep application writes stopped, preserve the failed database for diagnosis, restore the preflight snapshot into a clean database, verify the four legacy row counts and representative references, and point Kestrel One back to the restored database. Do not attempt to run old application code against the migrated schema.

The rollback procedure was tested by restoring the exact pre-migration snapshot into a fresh database and verifying the representative Chat, message, artifact, media job, share token, and `chat_id` relationships.

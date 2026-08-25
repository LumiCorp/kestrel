# Kestrel One control-worker rollout

The control worker is a manually published Fly image deployed to one exact
Machine at a time. It shares database and queue contracts with Kestrel One, so
a live Machine update must follow any required Web deployment and migration.
Publishing a tag is not deployment proof.

Use the repository-wide [production delivery runbook](../../../docs/production-delivery-channels.md)
for the protected `main` to `production` promotion and common provider gates.
This file owns the control-worker-specific order, verification, and rollback.

## 1. Set the release boundary

Before publishing anything:

1. Confirm the exact changes currently on `main` that the protected
   `main` to `production` pull request will promote.
2. Work from a clean checkout containing the intended production code.
3. Run `pnpm validate`.
4. Verify `vercel whoami`, `fly auth whoami`, and `docker info`.
5. Choose a new readable tag. Never overwrite the current or rollback tag.
6. Record the operator, start time, current production revision, both Vercel
   deployments, every control-worker Machine ID, state, check result, image
   tag, and resolved provider image.

List the exact Fly targets without changing them:

```bash
fly machine list --app kestrel-one-control-worker
fly releases --app kestrel-one-control-worker
```

Do not use `fly deploy` for a control-worker image rollout. The repository
publisher and one-Machine updater are the owning commands.

## 2. Satisfy Web and migration dependencies

When a release changes a shared database contract or transfers queue ownership
between Web and the control worker, merge the protected `main` to `production`
pull request before updating a live control-worker Machine. Wait for both
native Vercel deployments and require the Kestrel One migration/build to pass.

For durable Knowledge ingestion, check for duplicate nonterminal runs before
promotion:

```sql
SELECT document_id, count(*) AS nonterminal_runs
FROM knowledge_ingestion_runs
WHERE status IN ('queued', 'running')
GROUP BY document_id
HAVING count(*) > 1;
```

Migration `0079_durable_knowledge_ingestion` intentionally retains one active
run per document, marks superseded runs failed, and creates the partial unique
index. After the Kestrel One production deployment, verify the concrete schema
and data invariants:

```sql
SELECT to_regclass(
  'public.knowledge_ingestion_runs_active_document_idx'
) AS active_run_index;

SELECT document_id, count(*) AS nonterminal_runs
FROM knowledge_ingestion_runs
WHERE status IN ('queued', 'running')
GROUP BY document_id
HAVING count(*) > 1;
```

The index must resolve and the duplicate query must return no rows. Stop before
the Fly update if Kestrel One, Docs, migration, health, or these invariants fail.
This ordering prevents old Web consumer registration and the new control-worker
consumer from running as mixed-version owners.

## 3. Publish the selected image

From the clean production checkout, publish only the control-worker role:

```bash
pnpm production:image:publish \
  --role control-worker \
  --tag <tag>
```

The command builds `linux/amd64`, runs the image smoke, and pushes the selected
tag. Retain its final JSON output. The smoke proves only that the image starts
and rejects missing configuration correctly; it does not prove database access,
worker registration, reconciliation, or production work delivery.

## 4. Update started Machines first

Update one started Machine and no other target:

```bash
pnpm production:fly:machine \
  --role control-worker \
  --machine <started-machine-id> \
  --tag <tag>
```

Review the printed provider identity, current record, requested image, and exact
confirmation before continuing. Then verify that Machine before selecting
another one:

```bash
fly machine status <started-machine-id> --app kestrel-one-control-worker
fly logs --app kestrel-one-control-worker --machine <started-machine-id>
```

Require all of the following:

- the Machine remains started and its Fly check is passing;
- the provider record reports the requested image;
- logs report `Knowledge document workers registered.`;
- logs report `Knowledge document queue reconciliation completed.`;
- logs report `Kestrel One Control Worker started.`;
- no startup, reconciliation, or permanent-ingestion failure is attributable
  to the new Machine.

If more than one Machine is started, repeat the same one-Machine operation and
verification for each started Machine. Do not update a stopped Machine until
every started Machine in scope is healthy.

## 5. Prove durable Knowledge ingestion

For a release that changes Workspace backup creation, persistence, export, or
cleanup, first run the forced-retry production canary against an isolated
standalone scratch Workspace:

```bash
pnpm --dir apps/web canary:workspace-backup-retry -- \
  --thread <scratch-canary-thread-id> \
  --control-worker-machine <started-machine-id> \
  --tag <tag>
```

The command performs a read-only database and Fly preflight before printing an
exact four-part confirmation containing the Thread, Workspace, control-worker
Machine, and image tag. It queues one checkpoint backup, interrupts the sole
started control worker only after snapshot ownership is durable, proves pg-boss
retry/resume reuses that snapshot, authenticates and checksums the KWB2 archive,
checks temporary export cleanup, and retires the scratch Workspace. If the
snapshot is already ready at the interruption boundary, the result is
inconclusive and must be rerun with a fresh isolated fixture.

The command writes secret-free evidence under `test-results/canaries/`. On a
failure it restarts the control worker and preserves the Workspace, backup,
queue, snapshot, archive, and provider identities for diagnosis. Do not remove
an unexpected resource until its operation relationship is known. This
15-minute canary deadline is an observation limit; it does not change the
product's 120-second snapshot timeout.

Require a passing backup retry canary before the Knowledge proof below and
before updating a stopped standby. A passing backup canary does not replace the
Knowledge consumer proof.

Use a known queued or stranded Knowledge document, or upload a bounded fixture
through the production product. Record its document and run IDs. Verify:

1. Initial reconciliation preserves an authoritative created, retrying, or
   active job, or recovers one missing or terminal job exactly once.
2. Only one queued or running database run exists for the document.
3. Only one queue job is eligible to execute the run at a time.
4. The document reaches `ready` or an evidence-backed terminal failure.
5. A ready document has chunks, and Knowledge search returns a distinctive
   phrase from those chunks.
6. Reconciliation remains healthy for at least two intervals. The current
   interval is 60 seconds.

Useful read-only database evidence for the selected run is:

```sql
SELECT id, document_id, status, stage, attempt_count, error, diagnostics
FROM knowledge_ingestion_runs
WHERE id = '<run-id>';

SELECT id, name, state, retry_count, retry_limit, data
FROM pgboss.job
WHERE data->>'runId' = '<run-id>'
ORDER BY created_on, id;

SELECT status, chunk_count, error
FROM knowledge_documents
WHERE id = '<document-id>';
```

Production health alone is not Knowledge ingestion proof.

## 6. Update stopped Machines

After the started fleet and Knowledge path pass, update each stopped Machine
with a separate invocation:

```bash
pnpm production:fly:machine \
  --role control-worker \
  --machine <stopped-machine-id> \
  --tag <tag>
```

Confirm the provider record reports the requested image and the Machine remains
stopped. Do not start a standby merely to prove an image update.

## Rollback

If the started Machine fails, stop the rollout and restore that exact Machine
to its recorded previous tag with `production:fly:machine`. Do not update the
standby. If a Web rollback restores code that registers the previous consumer,
roll back the control worker in the same response so queue ownership does not
remain mixed.

Leave additive migration `0079` and its unique index in place. Queued runs can
remain durable for a recover-forward deployment. Never overwrite either the
failed tag or the previous tag.

## Closeout evidence

Record only observed results:

```text
Operator and time:
Promotion PR and included scope:
Kestrel One deployment / migration result:
Docs deployment result:
Published tag and image:
Started Machine before -> after -> checks:
Worker registration and reconciliation:
Knowledge document / run / job / chunks / search result:
Stopped Machine before -> after -> state:
Failures and disposition:
```

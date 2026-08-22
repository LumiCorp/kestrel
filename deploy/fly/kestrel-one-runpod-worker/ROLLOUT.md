# Kestrel One managed RunPod-worker rollout

The managed RunPod worker is a manually published Fly image deployed to one
exact Machine at a time. It owns managed RunPod qualification, provisioning,
retry, reconciliation, deletion, and usage jobs. A Fly worker image rollout
does not authorize provider spend or change a managed RunPod profile.

Use the repository-wide [production delivery runbook](../../../docs/production-delivery-channels.md)
for the protected `main` to `production` promotion and common provider gates.
This file owns RunPod-worker ordering, verification, and rollback.

## 1. Set the release boundary

Before publishing anything:

1. Confirm the exact changes currently on `main` that the protected
   `main` to `production` pull request will promote.
2. Work from a clean checkout containing the intended production code and run
   `pnpm validate`.
3. Verify `vercel whoami`, `fly auth whoami`, and `docker info`.
4. Choose a new readable tag. Never overwrite the current or rollback tag.
5. Record the operator, start time, production revision, both Vercel
   deployments, every RunPod-worker Machine ID, state, check result, image tag,
   and resolved provider image.
6. Identify an existing bounded run or separately approved qualification,
   reconciliation, or inference proof. Record its provider-spend authority.

Inspect the exact Fly targets without changing them:

```bash
fly machine list --app kestrel-one-runpod-worker
fly releases --app kestrel-one-runpod-worker
fly secrets list --app kestrel-one-runpod-worker
```

Do not print secret values. Confirm the required database, gateway encryption,
`RUNPOD_API_KEY`, and `RUNPOD_MANAGED_DEPLOYMENTS_ENABLED=true` configuration is
already active. Secret activation is a separate app-wide operation and must not
be bundled into an image update.

## 2. Satisfy Web and migration dependencies

When the image changes a database, queue, managed-deployment, gateway, or
provider contract shared with Web, complete the protected `main` to `production`
promotion before changing a live worker Machine. Wait for both native Vercel
deployments and require the Kestrel One migration/build and production health to
pass.

Stop before the Fly update if Web can enqueue a run the new worker cannot
consume, if the profile or deployment state is incompatible, or if the live
proof would create unapproved provider spend.

## 3. Publish the selected image

```bash
pnpm production:image:publish \
  --role runpod-worker \
  --tag <tag>
```

The command builds `linux/amd64`, runs the image smoke, and pushes the selected
tag. Retain its final JSON output. The smoke proves only the missing-database
configuration failure; it does not prove database access, RunPod credentials,
worker registration, queued-run recovery, provider behavior, usage ingestion,
or inference.

## 4. Update started Machines first

Update one started Machine and no other target:

```bash
pnpm production:fly:machine \
  --role runpod-worker \
  --machine <started-machine-id> \
  --tag <tag>
```

Then verify that exact Machine before selecting another one:

```bash
fly machine status <started-machine-id> --app kestrel-one-runpod-worker
fly logs --app kestrel-one-runpod-worker --machine <started-machine-id>
```

Require the Machine to remain started, report the requested image, and pass its
`worker` check. The check becomes healthy only after database readiness, queue
registration, scheduling, and initial queued-run recovery succeed. Logs must
report `Kestrel One managed RunPod worker started.` without a new startup,
provider, reconciliation, or usage failure attributable to the Machine.

Repeat the same one-Machine operation for every started Machine in scope before
updating any stopped Machine.

## 5. Prove managed RunPod work delivery

Prefer an existing queued or explicitly approved bounded run. Do not create a
deployment, qualification, or inference request solely to make the rollout look
complete. For the selected run, verify:

1. initial recovery preserves or restores the queued run;
2. one `ai.runpod.run` job carries the run while it is queued or active;
3. the database run advances through `queued` and `running` to `succeeded` or
   an evidence-backed terminal failure;
4. provider resource IDs and stored provenance match the selected run;
5. scheduled fleet reconciliation and usage ingestion show no new failure;
6. if inference is explicitly in scope, the approved model completes the
   bounded qualification or inference contract and its spend is recorded.

Useful read-only database evidence is:

```sql
SELECT id, kind, profile_id, deployment_id, status, provider_template_id,
       provider_endpoint_id, attempt, error_code, error_message, metadata,
       started_at, completed_at
FROM ai_deployment_runs
WHERE id = '<run-id>';

SELECT id, name, state, retry_count, retry_limit, data
FROM pgboss.job
WHERE name = 'ai.runpod.run'
  AND data->>'runId' = '<run-id>'
ORDER BY created_on, id;
```

Generic production health, image smoke, or a healthy RunPod endpoint unrelated
to the selected run is not managed RunPod work proof.

## 6. Update stopped Machines

After all started Machines and the approved work path pass, update each stopped
Machine with a separate invocation:

```bash
pnpm production:fly:machine \
  --role runpod-worker \
  --machine <stopped-machine-id> \
  --tag <tag>
```

Confirm the provider record reports the requested image and the Machine remains
stopped. Do not start a standby merely to prove an image update.

## Rollback

If a started Machine or approved work proof fails, stop the rollout and restore
that exact Machine to its recorded previous tag with `production:fly:machine`.
Do not update a standby and do not delete provider resources merely to hide a
failed proof. Preserve the run, job, provider, and spend evidence, then verify
health and an authorized work path after rollback.

## Closeout evidence

Record only observed results:

```text
Operator and time:
Promotion PR and included scope:
Kestrel One and Docs deployment results:
Published tag and image:
Started Machine before -> after -> checks:
Run / job / provider provenance / result:
Provider-spend authority and amount:
Reconciliation and usage observations:
Stopped Machine before -> after -> state:
Failures and disposition:
```

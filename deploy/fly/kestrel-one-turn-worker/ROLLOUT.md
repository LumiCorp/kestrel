# Kestrel One turn-worker rollout

The turn worker is a manually published Fly image deployed to one exact Machine
at a time. It owns durable turn execution, scheduled prompt dispatch, turn queue
reconciliation, and mobile push outbox maintenance. Publishing a tag is not
deployment proof.

Use the repository-wide [production delivery runbook](../../../docs/production-delivery-channels.md)
for the protected `main` to `production` promotion and common provider gates.
This file owns turn-worker ordering, verification, and rollback.

## 1. Set the release boundary

Before publishing anything:

1. Confirm the exact changes currently on `main` that the protected
   `main` to `production` pull request will promote.
2. Work from a clean checkout containing the intended production code and run
   `pnpm validate`.
3. Verify `vercel whoami`, `fly auth whoami`, and `docker info`.
4. Choose a new readable tag. Never overwrite the current or rollback tag.
5. Record the operator, start time, production revision, both Vercel
   deployments, every turn-worker Machine ID, state, check result, image tag,
   and resolved provider image.
6. Confirm admission is open and the intended active Machine count will remain
   available throughout the rollout.

Inspect the exact targets without changing them:

```bash
fly machine list --app kestrel-one-turn-worker
fly releases --app kestrel-one-turn-worker
```

## 2. Satisfy Web and migration dependencies

When the worker changes a database, queue, gateway-credential, schedule, mobile,
or runtime contract shared with Web, complete the protected `main` to
`production` promotion before changing a live Machine. Wait for both native
Vercel deployments and require the Kestrel One migration/build and production
health to pass.

Stop before the Fly update if Web can enqueue work the new worker cannot consume,
if required capacity state is unavailable, or if the active Machine count would
drop below the intended production capacity.

## 3. Publish the selected image

Load the production `KESTREL_ONE_APP_URL` and
`KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY` into the local process environment.
The publication command refuses to publish this role without them.

```bash
pnpm production:image:publish \
  --role turn-worker \
  --tag <tag>
```

The command builds `linux/amd64`, proves the missing-database failure, and then
runs the image's one-shot attachment canary before pushing. The canary does not
open Postgres or start pg-boss. It signs a worker request to Web, downloads a
fixed harmless object through Web-owned R2 signing, verifies size and SHA-256,
materializes it read-only, removes the temporary file, and emits JSON evidence.
Any canary failure prevents the push.

After publication, run the exact immutable tag once on a disposable Fly Machine
in the worker app. This Machine inherits the app's existing secrets, executes
only the canary command, never joins the queue, and removes itself on exit:

```bash
fly machine run registry.fly.io/kestrel-one-turn-worker:<tag> \
  --app kestrel-one-turn-worker \
  --region iad \
  --rm \
  --restart no \
  --entrypoint pnpm \
  -- --filter @kestrel/kestrel-one worker:turns:attachment-canary
```

Retain both JSON results and require `resolver`, `r2Download`, `materialized`,
and `readOnly` to be `true`, with the requested build ID. Stop before changing
an existing Machine if either proof fails. These checks do not prove database
access, gateway credentials, worker registration, reconciliation, capacity, or
live turn completion.

## 4. Update started Machines first

Update one started Machine and no other target:

```bash
pnpm production:fly:machine \
  --role turn-worker \
  --machine <started-machine-id> \
  --tag <tag>
```

Then verify that exact Machine before selecting another one:

```bash
fly machine status <started-machine-id> --app kestrel-one-turn-worker
fly logs --app kestrel-one-turn-worker --machine <started-machine-id>
```

Require the Machine to remain started, report the requested image, and pass its
`worker` check. That check becomes healthy only after database readiness,
gateway-credential readiness, worker registration, and initial maintenance
succeed. Logs must report `Kestrel One durable turn worker started.` without a
new startup or maintenance failure attributable to the Machine.

Repeat the same one-Machine operation for every started Machine in scope. Keep
at least the intended active capacity healthy, and do not update a stopped
Machine until every started Machine passes.

## 5. Prove durable turn delivery

Submit one bounded production canary turn through a supported client and record
its thread and turn IDs. Verify:

1. one authoritative `thread.turn.execute` job carries the turn while it is
   queued or active;
2. the turn advances from `queued` to `running` and reaches `completed`,
   `waiting_for_input`, or an evidence-backed terminal failure;
3. a completed turn has an output message and is visible after client reload;
4. another queued turn for the same thread does not execute concurrently;
5. scheduled prompt and mobile maintenance show no new failure attributable to
   the updated worker.

Useful read-only database evidence is:

```sql
SELECT id, thread_id, status, output_message_id, failure_code,
       failure_message, started_at, finished_at
FROM thread_turns
WHERE id = '<turn-id>';

SELECT id, name, state, retry_count, retry_limit, data
FROM pgboss.job
WHERE name = 'thread.turn.execute'
  AND data->>'turnId' = '<turn-id>'
ORDER BY created_on, id;
```

Observe at least two maintenance intervals; the current interval is 5 seconds.
Generic production health or image smoke is not durable turn proof.

## 6. Update stopped Machines

After all started Machines and the durable turn path pass, update each stopped
Machine with a separate invocation:

```bash
pnpm production:fly:machine \
  --role turn-worker \
  --machine <stopped-machine-id> \
  --tag <tag>
```

Confirm the provider record reports the requested image and the Machine remains
stopped. Do not start a standby merely to prove an image update.

## Rollback

If a started Machine or durable turn proof fails, stop the rollout and restore
that exact Machine to its recorded previous tag with `production:fly:machine`.
Do not update a standby. Preserve the affected durable turn and queue evidence,
then re-run health and a new bounded canary turn after rollback.

## Closeout evidence

Record only observed results:

```text
Operator and time:
Promotion PR and included scope:
Kestrel One and Docs deployment results:
Published tag and image:
Started Machine before -> after -> checks:
Canary thread / turn / job / terminal result:
Maintenance and capacity observations:
Stopped Machine before -> after -> state:
Failures and disposition:
```

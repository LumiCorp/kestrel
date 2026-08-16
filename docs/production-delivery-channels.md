---
id: production-delivery-channels
domain: operations
status: active
owner: kestrel-one
last_verified_at: 2026-08-15
depends_on:
  - ../.github/workflows/production-fly.yml
  - ../.github/workflows/production-runtime.yml
  - ../.github/workflows/production-runpod.yml
  - ../deploy/fly/image-catalog.json
  - ../apps/web/app/api/internal/production-images/route.ts
---

# Production delivery

`production` is the reviewed production decision. Vercel deploys that branch
natively. Its production build runs the ordinary locked, unpooled database
migrator before building Web; preview builds do not migrate production.

GitHub has three image jobs:

- Fly platform images: Preview Edge, turn worker, and control worker.
- Environment Runtime images: Workspace Runtime and Environment Router,
  always built as a pair.
- The managed RunPod worker image.

Each job selects catalog-owned changes, builds the affected image locally,
runs its existing image smoke, pushes a fixed
`production-<run-number>-<attempt>` tag, and calls Kestrel. GitHub does not
deploy Machines, coordinate provider revisions, synchronize configuration,
or manage rollback. Before notification, a publisher waits up to 15 minutes for
the authenticated production receiver to prove the repository's latest database
migration is applied, polling every five seconds. A runtime publisher also waits
until every Environment lifecycle-worker Machine uses the tag-capable contract.
It retries only receiver readiness while those conditions are unavailable;
authentication and other unexpected responses fail immediately. Each published
image then makes exactly one deployment notification attempt. A failed or
ambiguous notification fails the workflow and is retried only by rerunning it
with a new attempt tag.

## Platform images

`POST /api/internal/production-images` accepts a role and its fixed repository
tag using `PRODUCTION_IMAGE_DEPLOY_TOKEN`. Kestrel maps the role to its Fly app
and health check. An older build than any existing Machine is a successful stale
no-op. A transitional Machine makes the deployment fail closed. Kestrel uses one
running Machine and one stopped candidate. If the app has only one Machine, it
clones a stopped candidate; if every Machine is stopped, it starts and proves
one first. It then proves the candidate, updates the running Machines one at a
time, updates every additional stopped Machine, and stops the candidate. A final
provider read must show every Machine stable and configured with the requested
build tag before success. Fly's `image_ref.digest` is recorded separately, and
every Machine for the role must resolve that tag to the same digest.

Existing Machine configuration is preserved except for installing the role's
named readiness check. A failed standby is stopped before returning. If an
active update fails, the failed Machine is stopped and the proven standby stays
running, so there is no custom rollback controller.

Fly authority lives only in Vercel Production as `FLY_API_TOKEN` and
`KESTREL_FLY_ORGANIZATION_SLUG`. Image publication never copies or changes
application configuration or secrets.

## Environment Runtime images

The same endpoint records the newest published Workspace Runtime and Router
pair as `desired_version_id` and returns HTTP 202. The existing Environment
reconciliation cron requests the normal durable `environment.update` for the
configured canary. It promotes the current pointer only after that operation
reaches `environment.update.ready` and the canary stores the exact pair.

Runtime workflow success means only that the desired pair was recorded. GitHub
does not wait for backups, canary execution, live proofs, or promotion. The
platform Runtime page is the authority for desired, current, pending, failed,
and recovery-required state. It shows the exact canary operation and error.

A newer desired pair replaces an older desired pair. An operation for an older
pair cannot promote. A failed canary leaves the current pointer unchanged.
The cron does not retry it. **Retry desired** creates or requeues durable repair
work. **Canary previous version** selects the previous pair and requires a fresh
canary operation created after that selection before promotion. Rerunning the
workflow publishes a new attempt pair.
Pointer promotion affects new Environments only; existing Environments update
through their existing explicit runtime action or operator CLI.

Every runtime update snapshots the durable stopped Workspace set before its
first provider mutation. Stopped Workspaces start temporarily for the normal
health proof and return to stopped before the operation can become ready.
Running Workspaces remain running. Router and Workspace updates also reconcile
their control-plane URL values to `KESTREL_ONE_APP_URL` from the lifecycle
worker, repairing URL drift as part of the existing operation.

## Required production configuration

Vercel Production requires the normal Web contract plus:

- `POSTGRES_URL_NON_POOLING` or `DATABASE_URL_UNPOOLED` for migrations.
- `FLY_API_TOKEN` and `KESTREL_FLY_ORGANIZATION_SLUG` for platform Machines.
- `PRODUCTION_IMAGE_DEPLOY_TOKEN`, matching the GitHub Production secret.

GitHub Production requires registry credentials, the Kestrel production URL,
and the matching deployment token. No GitHub job receives database authority.

No live provider or branch mutation is part of repository validation. The
separate cutover advances `production` only after these values and the configured
canary are verified.

Before the first cutover, run the one-time preparation check and then explicitly
apply it:

```bash
pnpm --filter @kestrel/kestrel-one production-delivery:prepare
pnpm --filter @kestrel/kestrel-one production-delivery:prepare -- --apply
```

The command reports and permits active canary `workspace.backup` operations;
the repaired lifecycle worker drains them before runtime reconciliation can use
the same serialized lifecycle lane. It fails before mutation for any other
active canary lifecycle work, an active legacy release, an incorrect production
branch restriction, or an already-live new migration. Apply mode stages exact worker-role secrets,
installs one matching deployment token in Vercel and GitHub, and removes the two
legacy Web image values. It never deploys an image or advances `production`,
and it never prints secret values. Rerun check mode after apply and require a
clean result.

---
id: production-delivery-channels
domain: operations
status: active
owner: kestrel-one
last_verified_at: 2026-08-14
depends_on:
  - ../.github/workflows/production-database.yml
  - ../.github/workflows/production-fly.yml
  - ../.github/workflows/production-runpod.yml
  - ../deploy/fly/image-catalog.json
  - ../apps/web/lib/environments/runtime-channel.ts
---

# Production delivery channels

`production` is the reviewed human production decision. `main` never deploys
hosted production. The hosted product uses four independent lanes:

| Lane | Trigger and authority | Success proof | Rollback |
| --- | --- | --- | --- |
| Database | `production-database.yml`; direct unpooled Production secret | ordered migrator exits successfully | expand/deploy/contract; no destructive migration in the replacement cutover |
| Vercel | native Vercel Git deployment from `production` | Vercel production health and diagnostic build revision | promote the prior Vercel deployment |
| Fly | catalog-owned inputs selected by `production-fly.yml` | exact digest smoke, Machine digest convergence, provider health | deploy the recorded prior digest for that app |
| RunPod worker | RunPod-owned catalog inputs selected by `production-runpod.yml` | exact digest smoke, Machine digest convergence, private worker check | deploy its recorded prior digest |

No lane waits for another provider to serve the same source revision. Source
revisions remain useful diagnostics but are not cross-provider release state.

## Environment Runtime authority

Workspace Runtime and Environment Router are the only paired artifacts. An
immutable Environment Runtime Version records their role-specific GHCR digests
and source revisions. The singleton production Environment Runtime Channel
selects one current version and retains one previous version for rollback.

A changed runtime role is combined with the current unchanged role. The exact
pair must pass its image smoke, update the configured canary through the normal
durable `environment.update` lifecycle, pass the existing live Workspace and
preview canaries, and then win an atomic generation-checked pointer promotion.
Promotion changes the default for new Environments only. Existing Environments
update through the organization Runtime action or the operator CLI.

The runtime workflow authenticates every API call with a fresh GitHub OIDC
token restricted to `LumiCorp/kestrel`, `refs/heads/production`, the exact
`production-fly.yml` workflow and SHA, its run identity, and the dedicated
runtime-promotion audience. Image jobs never receive database credentials.

## Worker configuration and readiness

Vercel Production is canonical for shared process configuration. Run
`pnpm --dir apps/web sync:worker-config -- --role <role>` only as part of the
matching image deployment. The synchronizer selects the role allowlist, stages
known removals, preserves control-worker Fly authority on its Fly app, never
prints values, and does not activate staged changes by itself.

The turn, Environment lifecycle, and managed RunPod workers listen only on
their internal health port. `/healthz` returns 503 until configuration,
database access, and queue registration succeed. Fly top-level checks are the
deployment readiness authority; database heartbeat tables are not.

## Explicit Environment updates

An organization administrator can choose **Update to current runtime** on an
Environment Runtime page. The endpoint creates the existing idempotent durable
`environment.update` operation and returns HTTP 202. A conflicting lifecycle
operation or an already aligned Environment is rejected.

Operators may run:

```bash
pnpm --dir apps/web runtime:update -- --actor-user-id USER --version VERSION --environment ENVIRONMENT
pnpm --dir apps/web runtime:update -- --actor-user-id USER --version VERSION --batch --canary-operation OPERATION
```

Batch mode requires the named canary operation to have completed for the same
version while that version remains current. It creates no rollout or batch
state and is safe to rerun.

## Cutover and rollback

Repository validation performs no live mutation. Before advancing
`production`, verify branch protection, GitHub Production restrictions,
provider credentials, Vercel's Production Branch, the configured canary, and
the absence of active legacy releases, targets, or release-controller jobs.

Migration 0072 is additive. Until it lands, Web may read the old stable
Router/Workspace pair; every runtime mutation fails closed. After migration,
the new channel is authoritative even when it has no current version.

During the observation window, rollback each provider independently and select
the previous Environment Runtime Version only after canary proof. Legacy
physical release tables remain solely so pre-reset application revisions can
run during that window. The later contract-migration PR removes the bridge and
tables and explicitly ends rollback to pre-reset revisions.

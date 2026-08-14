# Hosted Environment runtime rollout

This runbook performs the maintenance-window cutover to Kestrel Edge-only
previews. Retirement migration 0053 invalidates every existing preview lease
and removes the retired provider contract, so the control plane,
Preview Edge, Environment Router, and Workspace Runtime must move to one
committed revision as a unit. Each Environment is upgraded through Kestrel
One's `environment.update` operation. The Workspace Runtime and Environment
Router are distinct images.
The `kestrel-one-runner` Fly App is only their existing private registry/build
target; do not deploy its legacy Dockerfile or use one cross-role digest as a
substitute for those images.

## Preconditions

1. Start from a committed revision with a clean worktree. The image revision
   label and the source revision must identify the same code.
2. Run `pnpm validate` and `pnpm validate:postgres`.
3. Confirm the production secret set contains the Environment ticket keys, Fly
   authority, App credential keyring, and Preview Edge service token. Do not
   copy model-provider credentials into a Fly Machine.
4. Record the current Kestrel One, Preview Edge, Environment Router, and
   Workspace Runtime image digests.
5. Create and verify the normal encrypted production database backup. The
   database backup and all prior image digests are one rollback unit.

## Build and publish the immutable runtime

Build and smoke-test the exact committed revision from the repository root:

```bash
RELEASE_SHA="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
WORKSPACE_IMAGE="kestrel-workspace-runtime:${RELEASE_SHA}"
ROUTER_IMAGE="kestrel-environment-router:${RELEASE_SHA}"

docker build \
  --file apps/workspace-runtime/Dockerfile \
  --build-arg "KESTREL_GIT_SHA=${RELEASE_SHA}" \
  --tag "${WORKSPACE_IMAGE}" \
  --progress plain \
  .

docker build \
  --file apps/environment-router/Dockerfile \
  --build-arg "KESTREL_GIT_SHA=${RELEASE_SHA}" \
  --tag "${ROUTER_IMAGE}" \
  --progress plain \
  .

EXPECTED_GIT_SHA="${RELEASE_SHA}" \
  apps/workspace-runtime/scripts/image-smoke.sh "${WORKSPACE_IMAGE}"

EXPECTED_GIT_SHA="${RELEASE_SHA}" \
  apps/environment-router/scripts/image-smoke.sh "${ROUTER_IMAGE}"
```

Publish the image through the approved Fly image pipeline. If `fly deploy` is
used as the builder, it must be build-only and must use the runner-specific
ignore file:

```bash
fly deploy . \
  --config apps/workspace-runtime/fly.build.toml \
  --build-only \
  --push \
  --build-arg "KESTREL_GIT_SHA=${RELEASE_SHA}"

fly deploy . \
  --config apps/environment-router/fly.build.toml \
  --build-only \
  --push \
  --build-arg "KESTREL_GIT_SHA=${RELEASE_SHA}"
```

Record both registry digests reported by the publisher.
`KESTREL_WORKSPACE_RUNTIME_IMAGE` must reference the Workspace Runtime digest,
and `KESTREL_ENVIRONMENT_ROUTER_IMAGE` must reference the Environment Router
digest. Both must use their immutable
`ghcr.io/lumicorp/kestrel-<role>@sha256:...` references, never a mutable tag,
Fly registry reference, or the same cross-role image.

## Enter maintenance and cut over the control plane

1. Begin the maintenance window. Preview publication and Environment upgrades
   remain unavailable until the hosted canary passes.
2. Apply retirement migration 0053. This intentionally deletes every existing
   preview lease and all retired provider state.
3. Deploy the reviewed Kestrel One control plane with the recorded immutable
   Workspace Runtime and Environment Router digests, then deploy the Preview
   Edge image built from the same revision.
4. Verify an unauthenticated request to
   `/api/runtime/environments/<environment-id>/gateway/config` returns `401`, not
   `404`, and confirm the returned authenticated contract is version 2.
5. Run `pnpm --dir apps/web preflight:environment:hosted -- --prepare` against
   the production configuration.

After migration 0053, old Environment Routers cannot consume the version 2
contract. Do not end maintenance until every Environment has completed its
owned update.

## Upgrade every Environment

1. In **Settings -> Environments -> Runtime**, submit the immutable digests for
   one canary Environment. This queues the owned `environment.update` operation;
   do not patch individual Machines manually.
2. Wait for the operation to complete `backing_up`, `gateway`, `workspaces`, and
   `verifying`, ending in `ready`.
3. Inspect Fly Machine configuration by key name only. The gateway must have
   `KESTREL_CONTROL_PLANE_URL`, `KESTREL_ENVIRONMENT_ID`, and
   `KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN`. Each upgraded Workspace must have
   `KESTREL_ENVIRONMENT_GATEWAY_URL` and `KESTREL_WORKSPACE_SERVICE_TOKEN`.
4. Verify the gateway health response reports `configurationReady: true`.
5. Run the existing Workspace post-cutover canary, then run
   `pnpm --dir apps/web canary:environment:preview` with a current Project
   execution ticket. Kestrel Edge is the only public preview ingress.
6. Close the returned preview and verify its URL no longer resolves through the
   gateway before accepting the canary.

Upgrade the remaining Environments one at a time only after the canary passes.
After the last update, remove retired provider secret keys from all Fly Machines,
deployment configuration, and CI. Verify only key names; never print values.
Query the production database to prove that no retired provider rows or
pre-cutover preview leases remain, then end maintenance.

## Failure and rollback boundaries

- After migration 0053 is applied, code-only or per-Environment rollback is
  unsupported.
- Rollback restores the encrypted database backup and all recorded prior image
  digests together while maintenance remains active.
- If an Environment update fails, retry the durable operation. If it cannot be
  completed before acceptance, restore the complete rollback unit.
- A failed preview relay must degrade only preview service. Model relay,
  Workspace routing, Tavily, and gateway health remain release gates and must
  continue to work.

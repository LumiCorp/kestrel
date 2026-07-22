# Hosted Environment runtime rollout

This runbook upgrades the public Environment gateway and its private Workspace
Machines without interrupting model access for Workspaces that still run the
previous image. The gateway and Workspace runtime are built from the same image,
but each Environment is upgraded through Kestrel One's `environment.update`
operation. Do not deploy the `kestrel-one-runner` Fly App as a substitute for
that operation.

## Preconditions

1. Start from a committed revision with a clean worktree. The image revision
   label and the source revision must identify the same code.
2. Run `pnpm validate` and `pnpm validate:postgres`.
3. Confirm the control-plane deployment still serves
   `/api/kestrel/gateway-credentials/lease`. That compatibility route must remain
   available until every existing Workspace has been upgraded.
4. Confirm the production secret set contains the Environment ticket keys, Fly
   authority, App credential keyring, and the temporary
   `KESTREL_ONE_CREDENTIAL_BROKER_TOKEN`. Do not copy ngrok or model-provider
   credentials into a Fly Machine.
5. Back up the production database and verify the rollback target before applying
   migrations.

## Build and publish the immutable runtime

Build and smoke-test the exact committed revision from the repository root:

```bash
RELEASE_SHA="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
IMAGE="kestrel-one-runner:${RELEASE_SHA}"

docker build \
  --file deploy/fly/kestrel-one-runner/Dockerfile \
  --build-arg "KESTREL_GIT_SHA=${RELEASE_SHA}" \
  --tag "${IMAGE}" \
  --progress plain \
  .

EXPECTED_GIT_SHA="${RELEASE_SHA}" \
  deploy/fly/kestrel-one-runner/smoke.sh "${IMAGE}"
```

Publish the image through the approved Fly image pipeline. If `fly deploy` is
used as the builder, it must be build-only and must use the runner-specific
ignore file:

```bash
fly deploy . \
  --app kestrel-one-runner \
  --build-only \
  --push \
  --dockerfile deploy/fly/kestrel-one-runner/Dockerfile \
  --ignorefile deploy/fly/kestrel-one-runner/Dockerfile.dockerignore \
  --build-arg "KESTREL_GIT_SHA=${RELEASE_SHA}"
```

Record the registry digest reported by the publisher. Both
`KESTREL_ENVIRONMENT_ROUTER_IMAGE` and `KESTREL_WORKSPACE_RUNTIME_IMAGE` must use
the immutable `registry.fly.io/...@sha256:...` reference, never a mutable tag.

## Deploy the compatibility control plane first

1. Apply the additive database migrations, including the Environment gateway
   identity and Workspace preview lease relations.
2. Deploy the reviewed Kestrel One control plane while its configured runtime
   images still point at the previous digest.
3. Verify an unauthenticated request to
   `/api/runtime/environments/<environment-id>/gateway/config` returns `401`, not
   `404`. This proves the new gateway configuration route is live without
   disclosing configuration.
4. Run `pnpm --dir apps/web preflight:environment:hosted -- --prepare` against
   the production configuration.

At this point old Workspace Machines continue to lease model credentials through
the legacy route, while the control plane is able to provision the scoped
gateway and Workspace identities required by the new runtime.

## Promote and upgrade one Environment

1. Configure the control-plane deployment with the recorded immutable digest for
   both runtime image variables, then promote that deployment.
2. In **Settings -> Environments -> Runtime**, submit the immutable digest for one
   canary Environment. This queues the owned `environment.update` operation; do
   not patch individual Machines manually.
3. Wait for the operation to complete `backing_up`, `gateway`, `workspaces`, and
   `verifying`, ending in `ready`.
4. Inspect Fly Machine configuration by key name only. The gateway must have
   `KESTREL_CONTROL_PLANE_URL`, `KESTREL_ENVIRONMENT_ID`, and
   `KESTREL_ENVIRONMENT_GATEWAY_SERVICE_TOKEN`. Each upgraded Workspace must have
   `KESTREL_ENVIRONMENT_GATEWAY_URL` and `KESTREL_WORKSPACE_SERVICE_TOKEN`, and
   must no longer have `KESTREL_ONE_CREDENTIAL_BROKER_TOKEN`.
5. Verify the gateway health response reports `configurationReady: true`.
6. Run the existing Workspace post-cutover canary, then run
   `pnpm --dir apps/web canary:environment:preview` with a current Project
   execution ticket and an Environment-scoped ngrok connection.
7. Close the returned preview and verify its URL no longer resolves through the
   gateway before accepting the canary.

Upgrade the remaining Environments one at a time only after the canary passes.
Keep the legacy credential route and its control-plane secret until Fly inventory
shows that no Workspace Machine is running the previous image.

## Failure and rollback boundaries

- If the compatibility control plane fails before any Environment update, roll
  back only the control-plane deployment. Existing Workspaces remain on the old
  image and route.
- If an Environment update fails before its gateway is healthy, leave the
  previous image configured and retry the durable operation. The update path
  preserves the previous runtime identity until health succeeds.
- If the gateway succeeds but a Workspace upgrade fails, do not remove the
  legacy route or broker secret. Retry or roll back that Environment before
  continuing to another one.
- A failed ngrok endpoint must degrade only preview service. Model relay,
  Workspace routing, Tavily, and gateway health remain release gates and must
  continue to work.
- Do not delete preview leases to force recovery. Closing leases are reconciled
  after the gateway acknowledges route removal.

Remove the compatibility route and `KESTREL_ONE_CREDENTIAL_BROKER_TOKEN` only in
a later release, after the complete Fly inventory and hosted canaries prove that
all Workspaces use scoped service identities.

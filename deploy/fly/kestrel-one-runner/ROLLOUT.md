# Hosted Environment runtime rollout

Workspace Runtime and Environment Router are separate GHCR images operated as
one manual pair. Kestrel One deploys that pair into tenant Fly Apps through one
durable Environment operation at a time. Publishing images does not update an
Environment, and activating a pair does not update the existing fleet.

Use the repository-wide [production delivery runbook](../../../docs/production-delivery-channels.md)
for the protected `main` to `production` promotion and common provider gates.
This file owns paired-image publication, canary Environment verification,
activation, per-Environment rollout, and rollback.

## 1. Set the release boundary

Before publishing anything:

1. Confirm the exact changes currently on `main` that the protected
   `main` to `production` pull request will promote.
2. Work from a clean checkout containing the intended production code and run
   `pnpm validate` plus any changed runtime boundary validations.
3. Verify `vercel whoami`, `fly auth whoami`, `docker info`, and GHCR push
   authority.
4. Choose one new readable tag for both images. Never overwrite the current or
   rollback tag and never mix tags within a pair.
5. Record the operator, start time, production revision, Vercel deployments,
   current runtime channel, selected canary Environment, and the current Router
   and Workspace image for every Environment in scope.

When the pair depends on Web APIs, schema, ticket, authorization, operation, or
runtime-channel changes, complete the protected `main` to `production` promotion
and verify both native Vercel deployments before queueing the first production
Environment update. The compatible control worker must also be healthy because
it executes the durable `environment.update` operation.

## 2. Publish both images

Load the production `KESTREL_ONE_APP_URL` and
`KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY` into the local process environment.
Workspace Runtime publication refuses to continue without them because its
image smoke runs the signed attachment/R2/materialization canary inside the
exact image. The canary creates no user turn and does not start a queue worker.

Publish each role with the same tag:

```bash
pnpm production:image:publish \
  --role workspace-runtime \
  --tag <tag>

pnpm production:image:publish \
  --role environment-router \
  --tag <tag>
```

Retain both final JSON results and resolve both GHCR image references. Each
command builds `linux/amd64`, runs its role-specific image smoke, and pushes one
tag. Workspace Runtime additionally proves the fixed Web-owned canary object can
be resolved, downloaded from R2, integrity-checked, and staged read-only. The
smokes prove image-local health and that bounded attachment path; they do not prove
tenant Fly configuration, control-plane compatibility, durable update behavior,
Workspace persistence, public previews, or a production agent turn.

Stop if either image fails to build, smoke, push, or resolve. Do not continue
with a mixed old/new pair.

## 3. Update one canary Environment

Queue one selected Fly Environment and no other target:

```bash
pnpm --dir apps/web runtime:update \
  --environment <environment-id> \
  --tag <tag>
```

Review the printed operator, current images, requested pair, exact Environment,
and confirmation. Record the returned operation ID and follow that operation
until it reaches `completed` at `environment.update.ready` or an evidence-backed
terminal failure.

Useful read-only database evidence is:

```sql
SELECT id, environment_id, type, status, stage, attempt, input, result,
       error_code, error_message, started_at, completed_at
FROM environment_operations
WHERE id = '<operation-id>';

SELECT id, status, runtime_image, router_image
FROM environments
WHERE id = '<environment-id>';

SELECT id, status, fly_machine_id, runtime_image
FROM environment_workspaces
WHERE environment_id = '<environment-id>'
ORDER BY id;
```

Require the Environment to report the requested Router image, every Workspace
to report the requested Workspace image, started Machines to become healthy,
and stopped Workspaces to remain stopped. Preserve the operation record and
provider state if the durable update fails; do not repair individual Machines
outside the owning operation while its outcome is unresolved.

## 4. Prove the selected Environment

Run the existing production Workspace and preview canaries against the selected
Environment with their required scoped credentials:

```bash
pnpm --dir apps/web canary:environment:workspace
pnpm --dir apps/web canary:environment:preview
```

Retain both JSON results and require:

- a supported client can activate the selected Environment;
- the agent command canary completes through the durable turn path;
- Workspace file create, read, update, conflict, tree, terminal, and application
  lifecycle checks pass;
- the public preview document, Vite client, and WebSocket upgrade pass;
- the canaries clean up their application, preview, terminal, and bounded files;
- Fly and Kestrel One show no new Router, Workspace, authorization, persistence,
  or reconciliation failure attributable to the pair.

An image smoke, completed update operation, or generic Environment health is not
full runtime-pair proof by itself.

## 5. Activate the default for new Environments

Only after the exact canary operation and both live canaries pass, activate the
pair for new provisioning:

```bash
pnpm --dir apps/web production:runtime:activate \
  --tag <tag> \
  --canary-operation <operation-id>
```

Review the current and proposed runtime versions, exact canary operation, and
confirmation. Retain the activation result and verify the runtime channel points
to the requested pair and exact canary Environment. Activation does not update
another existing Environment.

## 6. Update additional Environments explicitly

Repeat `runtime:update` for each approved Environment. Every Environment needs
its own reviewed operation, provider verification, and smallest affected
Workspace proof. There is no batch rollout or automatic fleet promotion.

## Rollback

Before activation, queue the same canary Environment with the recorded previous
pair tag, wait for `environment.update.ready`, and repeat the Workspace and
preview proofs.

After activation, first complete and verify a rollback canary operation using
the previous pair, then pass that exact operation to
`production:runtime:activate`. Existing Environments still require their own
explicit rollback operations. Never point the channel at an unverified pair or
repair only one image in a pair.

## Closeout evidence

Record only observed results:

```text
Operator and time:
Promotion PR and included scope:
Kestrel One, Docs, and control-worker readiness:
Workspace Runtime tag and image:
Environment Router tag and image:
Canary Environment / operation / provider images:
Workspace canary result:
Preview canary result:
Runtime channel before -> after:
Additional Environment operations:
Failures and disposition:
```

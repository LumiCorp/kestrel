---
id: runtime-deployments
domain: operations
status: active
owner: kestrel-one
last_verified_at: 2026-08-06
depends_on:
  - ../.github/workflows/fly-image-release.yml
  - ../deploy/fly/image-catalog.json
  - ../deploy/fly/runtime-rollout.json
  - ../apps/web/lib/runtime-deployments/reconcile.ts
---

# Runtime deployments

Kestrel One has no approval-driven global release transaction. GitHub Actions
deploys changed global applications directly, and the control worker reconciles
router and Workspace Runtime images from desired platform state.

The checked-in image catalog declares each image's build inputs. A merge builds
and smokes only impacted images. Preview Edge, the turn worker, RunPod worker,
and control worker deploy independently at immutable digests. A failure in one
global application does not create or pause a platform release record.

Router and Workspace Runtime images are published to
`POST /api/runtime/platform-images` using a GitHub Actions OIDC token bound to
the exact main-branch workflow and SHA. The latest publication increments the
platform generation and supersedes unfinished older operations.

## Required configuration

Configure the GitHub `Production` environment with:

- secret `FLY_API_TOKEN`, authorized for all catalog applications;
- variable `KESTREL_PLATFORM_IMAGE_URL`, set to
  `https://kestrelagents.dev/api/runtime/platform-images`.

The control plane and control worker use
`KESTREL_PLATFORM_RUNTIME_RECONCILIATION_MODE`:

- unset or `observe`: calculate shadow reconciliation without Fly mutation;
- `active`: own desired-state rollout and ignore legacy release-target locks.

Switch both processes to `active` only after migration 0061 and shadow output
have been verified. The old release APIs remain read-only operational history
during the two-rollout proof window.

## Normal rollout

`deploy/fly/runtime-rollout.json` normally declares `rolling`. Rolling changes
must retain compatibility with the current and previous control-plane, router,
and Workspace Runtime contracts. The validation matrix lives in
`deploy/fly/runtime-compatibility.json`.

The control worker targets the persistent canary first. It updates and verifies
only the gateway, then creates one independent rebuild operation for each
running Workspace. Stopped Workspaces remain stopped and adopt the target image
on their next start. After canary health passes, every eligible Environment is
targeted independently. One blocked resource makes the aggregate status
`degraded`; other Environments continue.

Normal image updates preserve service credentials and create no Workspace
archive or Fly snapshot. A content-aware backup runs only when the rollout
contract declares a Workspace data migration.

## Retry, rejection, and rollback

Network failures and Fly 408, 429, and 5xx responses reconcile authoritative
Machine state before replay. Persistent retry state uses 5, 10, 20, 40, 80,
then 120 second delays for at most one hour. Authentication, validation,
missing-resource, and contract failures block only the owning resource.

Failed image health starts a safety rollback to the prior verified digest.
Safety rollback keeps retrying at capped backoff until the prior image is
healthy or the resource is diagnosed as unrecoverable; it is not abandoned at
the ordinary one-hour deadline. A rejected canary prevents new-image fanout but
does not stop existing service or unrelated global applications.

Admin **Runtime Deployment** shows desired and verified images, generation,
resource retry evidence, and resource-local retry and rollback actions. Manual
retry appears only for terminal resource failures.

## Maintenance

Workspace data-format migrations require `maintenance` mode and a non-null
migration revision. Images still build and smoke on merge, but the publisher
will not activate them. Activation requires a `workflow_dispatch` for the exact
source SHA; the same resource reconciler then performs a content-aware backup
before mutating each Workspace. Backup failure blocks only that Workspace.

## Legacy retirement

After two successful production runtime generations and one rollback drill,
remove candidate mutation APIs, the Fly release queue, active-release recovery,
and stable-release lookup. Keep release rows read-only until a later migration
proves there are no readers. Preserve KWB1/KWB2 restore compatibility and the
content-aware backup lifecycle.

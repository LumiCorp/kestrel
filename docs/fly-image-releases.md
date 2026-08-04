---
id: fly-image-releases
domain: operations
status: active
owner: kestrel-one
last_verified_at: 2026-08-03
depends_on:
  - ../.github/workflows/fly-image-release.yml
  - ../deploy/fly/image-catalog.json
  - ../apps/web/lib/releases/runtime.ts
---

# Fly image releases

Kestrel publishes the Workspace Runtime, Environment Router, Preview Edge,
turn worker, and RunPod worker as one coordinated release bundle. A main-branch
change rebuilds only the images whose declared catalog inputs changed. The
Monday 14:00 UTC schedule rebuilds all five images. Every candidate contains
immutable Fly registry digests; unchanged roles are carried forward from the
stable bundle. Incremental impact and migration detection are calculated from
the stable bundle revision so consecutive unapproved candidates cannot drop an
earlier main-branch change.

## Required configuration

Configure the GitHub `Production` environment with:

- secret `FLY_API_TOKEN`, authorized to build and push all catalog apps;
- variable `KESTREL_RELEASE_PUBLISH_URL`, set to the deployed Kestrel One
  `/api/runtime/releases/candidates` URL.

The `publish-candidate` job must remain attached to that environment so GitHub
Actions makes the release secret and URL available to the workflow.

The Kestrel One worker that processes promotions requires `FLY_API_TOKEN` and
`KESTREL_FLY_ORGANIZATION_SLUG` so it can update the three platform Fly Apps.
The existing `KESTREL_WORKSPACE_RUNTIME_IMAGE` and
`KESTREL_ENVIRONMENT_ROUTER_IMAGE` values remain bootstrap fallbacks until the
first release becomes stable. Postgres is authoritative after that point.

The candidate endpoint accepts only a GitHub Actions OIDC token for the exact
main-branch release workflow and commit SHA. No long-lived publisher secret is
shared with Kestrel One.

## Promotion

1. Open Kestrel Admin, choose **Releases**, and select a dedicated Fly canary
   Environment.
2. Review the candidate's rebuilt and carried-forward components.
3. If the candidate contains a Web database migration, apply it through the
   normal Kestrel One deployment path, verify `pnpm --dir apps/web
   db:migrate:deploy` completed against the production database, and verify the
   control plane is healthy. Then mark the migration runbook complete. This
   acknowledgment records the administrator and time; it does not run a
   migration.
4. Approve the release.

Promotion updates Preview Edge and the RunPod worker, then the canary, then all
other active Fly Environments sequentially, and finally the turn worker. New
executions are blocked for the Environment currently draining. A drain that
still has active executions after 30 minutes pauses the release.

The canary must be ready or degraded when selected and when promotion starts.
Requested or provisioning Environments wait for provisioning before rollout.
Non-canary Environments that become failed, deleting, deleted, or archived are
recorded as skipped so an unavailable Environment cannot deadlock promotion or
rollback.

Stopped Workspaces receive a direct volume snapshot and immutable image update
without being launched. They remain `configured_unverified` until their next
start verifies health on the new digest. Desktop Environments are excluded.

## Failure and recovery

The first failed target pauses promotion. Inspect the failed target in Admin,
fix the external condition, and choose **Retry failed target**. There is no
automatic rollback. Choose **Roll back to stable** only when the active release
is paused; rollback creates a new coordinated release using the prior stable
digests and follows the same canary-first rollout.

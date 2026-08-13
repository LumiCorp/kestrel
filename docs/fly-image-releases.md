---
id: fly-image-releases
domain: operations
status: active
owner: kestrel-one
last_verified_at: 2026-08-13
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
immutable OCI digests. Workspace Runtime and Environment Router are signed and
published publicly at `ghcr.io/lumicorp/kestrel-workspace-runtime` and
`ghcr.io/lumicorp/kestrel-environment-router`; platform services remain in
their exact private Fly repositories. Unchanged roles are carried forward from
the stable bundle. Incremental impact and migration detection are calculated from
the stable bundle revision so consecutive unapproved candidates cannot drop an
earlier main-branch change.

## Required configuration

Configure the GitHub `Production` environment with:

- secret `FLY_API_TOKEN`, authorized to build and push all catalog apps;
- variable `KESTREL_RELEASE_PUBLISH_URL`, set to the deployed Kestrel One
  `/api/runtime/releases/candidates` URL.

The workflow's GitHub token needs `packages: write`. Both tenant-runtime GHCR
packages must be public. Before accepting a candidate, the publisher resolves
each pushed tag to a digest, runs its image smoke test, signs the digest with
keyless Cosign, verifies the exact workflow identity, and proves an anonymous
digest pull.

The `publish-candidate` job must remain attached to that environment so GitHub
Actions makes the release secret and URL available to the workflow.

The dedicated Kestrel One control worker processes promotions and hosted
Environment lifecycle work. It requires `FLY_API_TOKEN` and
`KESTREL_FLY_ORGANIZATION_SLUG` so it can update the three platform Fly Apps.
The turn worker processes durable user turns only and is never a release queue
owner. Controller-owned queue names include the controller contract revision;
an older turn worker therefore cannot claim lifecycle work produced after the
ownership cutover.
Platform credentials are never a fallback for tenant provisioning. Each tenant
Environment operation resolves only that Kestrel organization's encrypted Fly
connection and creates resources only in the exact user-entered Fly organization.

The existing `KESTREL_WORKSPACE_RUNTIME_IMAGE` and
`KESTREL_ENVIRONMENT_ROUTER_IMAGE` values remain bootstrap fallbacks until the
first release becomes stable. Postgres is authoritative after that point.

The candidate endpoint accepts only a GitHub Actions OIDC token for the exact
main-branch release workflow and commit SHA. Both authenticated preflight and
the authoritative publication POST require a fresh controller heartbeat at the
canonical contract revision. Missing, expired, or insufficient-revision
heartbeats fail with `409 RELEASE_CONTROLLER_STALE`. A successful publication
response is accepted only when it contains a UUID release ID and the literal
status `candidate`; malformed 2xx responses fail the workflow.

The `publish-candidate` job uses the setup action at its pinned commit and Fly
CLI `0.4.82`. Its fail-fast order is fixed: validate the revision, authenticate
the Fly registry, wait for `/api/health` to serve the exact commit, complete the
authenticated publication preflight, build and smoke the non-deploying
controller candidate, then build, smoke, and publish the managed image bundle.
The final POST repeats the heartbeat check to close the race across long image
builds. Controller deployment is a separate, explicit operation; candidate
publication never changes the running or stopped controller Machines.
A candidate is accepted and promoted only while its bundle revision still equals
the serving Kestrel One revision. Newer main revisions cancel obsolete image
builds. No long-lived publisher secret is shared with Kestrel One.

Every manifest records the gateway configuration version emitted by Kestrel
One and the versions accepted by the Environment Router. Change this contract
in two releases: first expand and stabilize router acceptance while the producer
continues emitting the old version; only then change the producer. Rollback is
available only when the stable router explicitly accepts the live producer
version.

## Controller release gate

Bootstrap or deliberately repair the production controller from a clean,
committed revision with:

```bash
pnpm --dir apps/web release:control-worker
```

The command pulls the canonical `lumi-kestrel/one` production configuration,
selects only the explicit controller allowlist, passes secrets to Fly through
standard input, and refuses the cutover while a legacy release or Environment
lifecycle queue has nonterminal work. It deploys the exact local commit and
verifies the readiness file and database heartbeat. Do not run this command in
pull-request CI.

The main release workflow uses a non-deploying controller candidate path. It
computes a fingerprint from the controller Dockerfile, Fly config, controller
scripts, the bundled worker and readiness artifacts, lockfile, package
manifests, schema, and database migrations. It builds and pushes an image
containing only the bundled artifacts, resolves and smokes the immutable Fly
registry digest, and records that evidence in the workflow log. It does not
inspect or update the controller Machine topology.

Every managed image smoke runs an executable image contract. In particular,
the turn-worker smoke invokes the image's real default `CMD`, requires the exact
missing-database startup failure, and verifies the immutable image's Git
revision label. A source-file check or `tsx --version` is not sufficient release
evidence.

The explicit controller deployment path updates the stopped standby first and
then the single running Machine. Fly may transcode an OCI manifest to its
deployment manifest, so post-update verification binds the authoritative
Machine state to the exact source revision, controller input fingerprint, and
startup command instead of requiring the source manifest digest to survive that
provider-owned representation change.

## Promotion

1. Open Kestrel Admin, choose **Releases**, and select a dedicated Fly canary
   Environment.
2. Review the candidate's rebuilt and carried-forward components.
3. If the candidate contains a Web database migration, apply it through the
   normal Kestrel One deployment path, verify
   `pnpm --dir apps/web db:migrate:deploy` completed against the production
   database, and verify the control plane is healthy. Then mark the migration
   runbook complete. This
   acknowledgment records the administrator and time; it does not run a
   migration.
4. Approve the release.

When Environment images change, promotion updates the canary first, then
Preview Edge, the RunPod worker, all other active Fly Environments sequentially,
and finally the turn worker. Global-only bundles retain Preview Edge, RunPod,
then turn-worker order. New
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

Retryable provider failures do not immediately pause promotion. Network errors,
HTTP 408, 429, and 5xx responses enter a persisted 15-minute retry window. The
controller reads authoritative provider state before every retry; if the target
already satisfies the requested postcondition, it completes the target without
replaying the mutation. Admin shows the attempt, next retry time, last provider
response, and authoritative state while the release remains deploying.

Promotion pauses immediately for non-retryable failures, contradictory provider
state, or failed health checks, and pauses when the retry budget is exhausted.
Only then is **Retry failed target** available. There is no automatic rollback.
Choose **Roll back to stable** only when the active release is paused; rollback
creates a new coordinated release for targets the failed release may already
have mutated and follows the same canary-first rollout. Rollback is blocked when
the stable router has unknown or incompatible gateway evidence.

When a legacy stable bundle lacks compatibility metadata, deploy the repair with
`KESTREL_RELEASE_COMPATIBILITY_BOOTSTRAP=allow-legacy-stable`. This literal is a
one-time bridge: Kestrel rejects it after a metadata-bearing stable bundle
exists. While the legacy rollback remains paused, publish the exact repair
candidate and choose **Recover forward**. Forward recovery supersedes the paused
release atomically and starts with the saved canary. Remove the bridge and
redeploy the same revision immediately after the recovered release becomes
stable.
